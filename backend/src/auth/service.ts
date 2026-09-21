import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import argon2 from 'argon2';
import type pg from 'pg';
import type { Request, Response } from 'express';
import { password, username, label, type SessionView } from '@jce/shared';
import { z } from 'zod';
import { withTransaction, type Transaction } from '../db/transaction.js';
import { HttpError, recordChange } from '../management/common.js';
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const hashPassword = (value: string) =>
  argon2.hash(password.parse(value), {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export const verifyPassword = (hash: string, value: string) =>
  argon2.verify(hash, value);
export type AuthOptions = { origin: string; insecureLoopback: boolean };
export type AuthSession = SessionView & { hash: string };
export const authLock = (tx: Transaction) =>
  tx.query('SELECT pg_advisory_xact_lock(74012003)');
const unauth = () =>
  new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
const cookieName = (options: AuthOptions) =>
  options.insecureLoopback ? 'jce_session' : '__Host-jce_session';
export function cookieToken(req: Request, options: AuthOptions) {
  const entries = (req.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim().split('='));
  const token = entries.find(([key]) => key === cookieName(options))?.[1];
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function setCookie(res: Response, token: string, options: AuthOptions) {
  res.cookie(cookieName(options), token, {
    httpOnly: true,
    secure: !options.insecureLoopback,
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 3600 * 1000,
  });
}
export function clearCookie(res: Response, options: AuthOptions) {
  res.clearCookie(cookieName(options), {
    httpOnly: true,
    secure: !options.insecureLoopback,
    sameSite: 'strict',
    path: '/',
  });
}
export function checkTransport(req: Request, options: AuthOptions) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
    req.socket.remoteAddress ?? '',
  );
  if (!req.secure && !(options.insecureLoopback && loopback))
    throw new HttpError(
      403,
      'HTTPS_REQUIRED',
      'Use the configured HTTPS address.',
    );
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.get('origin') !== options.origin
  )
    throw new HttpError(
      403,
      'ORIGIN_REJECTED',
      'Request origin is not allowed.',
    );
}
export function checkCsrf(req: Request, session: AuthSession) {
  const supplied = req.get('x-csrf-token') ?? '';
  if (
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken))
  )
    throw new HttpError(
      403,
      'CSRF_REJECTED',
      'Reload this page and try again.',
    );
}
export async function readSession(
  tx: pg.Pool | Transaction,
  token: string | null,
): Promise<AuthSession> {
  if (!token) throw unauth();
  const hash = digest(token);
  const row = (
    await tx.query<{
      id: string;
      username: string;
      display_name: string;
      must_change_password: boolean;
      branch_id: string | null;
      locked: boolean;
    }>(
      `SELECT u.id,u.username,u.display_name,u.must_change_password,s.branch_id,s.locked FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND NOT u.disabled AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'`,
      [hash],
    )
  ).rows[0];
  if (!row) throw unauth();
  const roles = (
    await tx.query<{ role_code: string }>(
      'SELECT role_code FROM user_roles WHERE user_id=$1',
      [row.id],
    )
  ).rows.map((r) => r.role_code);
  const permissions = (
    await tx.query<{ permission_code: string }>(
      'SELECT DISTINCT permission_code FROM role_permissions p JOIN user_roles r ON r.role_code=p.role_code WHERE r.user_id=$1',
      [row.id],
    )
  ).rows.map((r) => r.permission_code);
  const branches = (
    await tx.query<{ id: string; name: string; code: string }>(
      'SELECT b.id,b.name,b.code FROM branches b JOIN branch_users m ON m.branch_id=b.id WHERE m.user_id=$1 AND b.archived_at IS NULL ORDER BY b.code',
      [row.id],
    )
  ).rows;
  return {
    hash,
    user: { id: row.id, username: row.username, displayName: row.display_name },
    roles,
    permissions,
    branches,
    branchId: branches.some((b) => b.id === row.branch_id)
      ? row.branch_id
      : null,
    csrfToken: digest(`csrf:${token}`),
    locked: row.locked,
    mustChangePassword: row.must_change_password,
  };
}
export function publicSession(session: AuthSession): SessionView {
  return {
    user: session.user,
    roles: session.roles,
    permissions: session.permissions,
    branches: session.branches,
    branchId: session.branchId,
    csrfToken: session.csrfToken,
    locked: session.locked,
    mustChangePassword: session.mustChangePassword,
  };
}
export function authorize(
  session: AuthSession,
  permission?: string,
  branchId?: string,
) {
  if (session.locked)
    throw new HttpError(423, 'LOCKED', 'Unlock this workstation.');
  if (session.mustChangePassword)
    throw new HttpError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'Change your password before continuing.',
    );
  if (permission && !session.permissions.includes(permission))
    throw new HttpError(
      403,
      'FORBIDDEN',
      'You do not have permission for this action.',
    );
  if (branchId && !session.branches.some((b) => b.id === branchId))
    throw new HttpError(
      403,
      'BRANCH_FORBIDDEN',
      'This branch is not assigned to you.',
    );
}
export async function bootstrapAdministrator(pool: pg.Pool, input: unknown) {
  const data = z
    .object({ username, displayName: label.max(120), password })
    .strict()
    .parse(input);
  const hash = await hashPassword(data.password);
  return withTransaction(pool, async (tx) => {
    await authLock(tx);
    if ((await tx.query('SELECT 1 FROM users LIMIT 1')).rowCount)
      throw new Error('Administrator bootstrap is already complete.');
    const id = randomUUID();
    await tx.query(
      'INSERT INTO users(id,username,display_name,password_hash,must_change_password) VALUES($1,$2,$3,$4,false)',
      [id, data.username, data.displayName, hash],
    );
    await tx.query("INSERT INTO user_roles VALUES($1,'admin')", [id]);
    await tx.query(
      'INSERT INTO branch_users SELECT $1,id FROM branches WHERE archived_at IS NULL',
      [id],
    );
    await recordChange(tx, id, null, 'user', id, 1);
    return id;
  });
}
export async function consumeAttempt(
  pool: pg.Pool,
  key: string,
  limit: number,
) {
  const row = (
    await pool.query<{ attempts: number }>(
      `INSERT INTO login_throttles(key_hash,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN login_throttles.reset_at<now() THEN 1 ELSE login_throttles.attempts+1 END,reset_at=CASE WHEN login_throttles.reset_at<now() THEN now()+interval '15 minutes' ELSE login_throttles.reset_at END RETURNING attempts`,
      [digest(key)],
    )
  ).rows[0]!;
  if (row.attempts > limit)
    throw new HttpError(
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many attempts. Try again in 15 minutes.',
    );
}
export async function newSession(tx: Transaction, userId: string) {
  const token = randomBytes(32).toString('hex');
  const branch =
    (
      await tx.query<{ branch_id: string }>(
        'SELECT branch_id FROM branch_users m JOIN branches b ON b.id=m.branch_id WHERE user_id=$1 AND b.archived_at IS NULL ORDER BY b.code LIMIT 1',
        [userId],
      )
    ).rows[0]?.branch_id ?? null;
  await tx.query(
    "INSERT INTO user_sessions(token_hash,user_id,branch_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
    [digest(token), userId, branch],
  );
  return token;
}
