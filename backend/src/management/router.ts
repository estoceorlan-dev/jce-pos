import { randomUUID } from 'node:crypto';
import express from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  username,
  password,
  uuid,
  code,
  version,
  userInput,
  branchInput,
  businessInput,
  branchSettingsInput,
  managedPermissions,
} from '@jce/shared';
import { withTransaction, type Transaction } from '../db/transaction.js';
import { registerBranch, registerTerminal } from '../db/identity.js';
import {
  authorize,
  authLock,
  checkCsrf,
  checkTransport,
  clearCookie,
  consumeAttempt,
  cookieToken,
  hashPassword,
  newSession,
  publicSession,
  readSession,
  setCookie,
  verifyPassword,
  type AuthOptions,
  type AuthSession,
} from '../auth/service.js';
import {
  HttpError,
  requireFound,
  requireUpdated,
  recordChange,
} from './common.js';
import { installCatalog } from './catalog.js';
export type Context = {
  tx: Transaction;
  session: AuthSession;
  req: express.Request;
  branchId: string | null;
};
export type Endpoint = (
  method: 'get' | 'post' | 'put',
  path: string,
  permission: string | undefined,
  handler: (ctx: Context) => Promise<unknown>,
  relaxed?: boolean,
) => void;
export function managementRouter(pool: pg.Pool, options: AuthOptions) {
  const router = express.Router();
  router.use((req, _res, next) => {
    checkTransport(req, options);
    next();
  });
  // Identical work for an unknown username; no reusable default password.
  const dummyHash = hashPassword(randomUUID() + randomUUID());
  router.post('/auth/login', async (req, res) => {
    const data = z
      .object({ username, password: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    await consumeAttempt(pool, `ip:${req.ip}`, 100);
    await consumeAttempt(pool, `user:${data.username}`, 10);
    const row = (
      await pool.query<{
        id: string;
        password_hash: string;
        disabled: boolean;
      }>('SELECT id,password_hash,disabled FROM users WHERE username=$1', [
        data.username,
      ])
    ).rows[0];
    const valid = await verifyPassword(
      row?.password_hash ?? (await dummyHash),
      data.password,
    );
    const token = await withTransaction(pool, async (tx) => {
      await authLock(tx);
      const current = row
        ? (
            await tx.query<{ password_hash: string; disabled: boolean }>(
              'SELECT password_hash,disabled FROM users WHERE id=$1',
              [row.id],
            )
          ).rows[0]
        : undefined;
      const success = !!(
        valid &&
        current &&
        !current.disabled &&
        current.password_hash === row?.password_hash
      );
      await tx.query(
        'INSERT INTO login_logs(id,user_id,success) VALUES($1,$2,$3)',
        [randomUUID(), row?.id ?? null, success],
      );
      return success ? newSession(tx, row!.id) : null;
    });
    if (!token)
      throw new HttpError(
        401,
        'LOGIN_FAILED',
        'Username or password is incorrect.',
      );
    setCookie(res, token, options);
    res.json(publicSession(await readSession(pool, token)));
  });
  const endpoint: Endpoint = (
    method,
    path,
    permission,
    handler,
    relaxed = false,
  ) => {
    router[method](path, async (req, res) => {
      const output = await withTransaction(pool, async (tx) => {
        await authLock(tx);
        const session = await readSession(tx, cookieToken(req, options));
        if (method !== 'get') checkCsrf(req, session);
        const rawBranch = req.params['branchId'];
        const branchId = rawBranch ? uuid.parse(rawBranch) : null;
        if (!relaxed) {
          // An assigned archived branch must remain administrable for reactivation.
          if (path === '/branches/:branchId') {
            authorize(session, permission);
            if (
              !(
                await tx.query(
                  'SELECT 1 FROM branch_users WHERE user_id=$1 AND branch_id=$2',
                  [session.user.id, branchId],
                )
              ).rowCount
            )
              throw new HttpError(
                403,
                'BRANCH_FORBIDDEN',
                'This branch is not assigned to you.',
              );
          } else authorize(session, permission, branchId ?? undefined);
        }
        // Background session checks must not prevent idle expiry or prolong a lock.
        if (path !== '/auth/session' && !session.locked)
          await tx.query(
            'UPDATE user_sessions SET last_seen_at=now() WHERE token_hash=$1',
            [session.hash],
          );
        return handler({ tx, session, req, branchId });
      });
      if (path === '/auth/logout') clearCookie(res, options);
      if (output && typeof output === 'object' && 'csv' in output) {
        res.type('text/csv').attachment('export.csv').send(output.csv);
      } else res.json(output ?? { ok: true });
    });
  };
  endpoint(
    'get',
    '/auth/session',
    undefined,
    async ({ session }) => publicSession(session),
    true,
  );
  endpoint(
    'post',
    '/auth/logout',
    undefined,
    async ({ tx, session }) => {
      await tx.query(
        'UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1',
        [session.hash],
      );
    },
    true,
  );
  endpoint(
    'post',
    '/auth/lock',
    undefined,
    async ({ tx, session }) => {
      await tx.query(
        'UPDATE user_sessions SET locked=true WHERE token_hash=$1',
        [session.hash],
      );
    },
    true,
  );
  endpoint(
    'post',
    '/auth/unlock',
    undefined,
    async ({ tx, session, req }) => {
      const input = z
        .object({ password: z.string().min(1).max(128) })
        .strict()
        .parse(req.body);
      await consumeAttempt(pool, `unlock:${session.user.id}`, 10);
      const user = (
        await tx.query<{ password_hash: string }>(
          'SELECT password_hash FROM users WHERE id=$1',
          [session.user.id],
        )
      ).rows[0]!;
      if (!(await verifyPassword(user.password_hash, input.password)))
        throw new HttpError(401, 'UNLOCK_FAILED', 'Password is incorrect.');
      await tx.query(
        'UPDATE user_sessions SET locked=false,last_seen_at=now() WHERE token_hash=$1',
        [session.hash],
      );
    },
    true,
  );
  endpoint(
    'post',
    '/auth/password',
    undefined,
    async ({ tx, session, req }) => {
      if (session.locked)
        throw new HttpError(423, 'LOCKED', 'Unlock this workstation.');
      const data = z
        .object({ currentPassword: z.string().min(1).max(128), password })
        .strict()
        .parse(req.body);
      await consumeAttempt(pool, `password:${session.user.id}`, 10);
      const row = (
        await tx.query<{ password_hash: string }>(
          'SELECT password_hash FROM users WHERE id=$1',
          [session.user.id],
        )
      ).rows[0]!;
      if (!(await verifyPassword(row.password_hash, data.currentPassword)))
        throw new HttpError(
          400,
          'PASSWORD_INCORRECT',
          'Current password is incorrect.',
        );
      if (await verifyPassword(row.password_hash, data.password))
        throw new HttpError(
          400,
          'PASSWORD_UNCHANGED',
          'Choose a different password.',
        );
      const changed = await tx.query<{ version: number }>(
        'UPDATE users SET password_hash=$2,must_change_password=false,version=version+1 WHERE id=$1 RETURNING version',
        [session.user.id, await hashPassword(data.password)],
      );
      await recordChange(
        tx,
        session.user.id,
        null,
        'user',
        session.user.id,
        changed.rows[0]!.version,
      );
    },
    true,
  );
  endpoint('post', '/auth/branch', undefined, async ({ tx, session, req }) => {
    const data = z.object({ branchId: uuid }).strict().parse(req.body);
    authorize(session, undefined, data.branchId);
    await tx.query(
      'UPDATE user_sessions SET branch_id=$2 WHERE token_hash=$1',
      [session.hash, data.branchId],
    );
  });
  endpoint(
    'get',
    '/roles',
    'users.manage',
    async ({ tx }) =>
      (
        await tx.query(
          "SELECT r.code,r.name,r.version,coalesce(array_agg(p.permission_code) FILTER(WHERE p.permission_code IS NOT NULL),'{}') AS permissions FROM roles r LEFT JOIN role_permissions p ON r.code=p.role_code GROUP BY r.code ORDER BY r.code",
        )
      ).rows,
  );
  endpoint(
    'put',
    '/roles/:role',
    'users.manage',
    async ({ tx, session, req }) => {
      if (!session.roles.includes('admin') || req.params['role'] === 'admin')
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Only an administrator may edit non-administrator permissions.',
        );
      const data = z
        .object({
          permissions: z.array(z.enum(managedPermissions)).max(30),
          version,
        })
        .strict()
        .parse(req.body);
      const role = z
        .enum(['manager', 'cashier', 'inventory'])
        .parse(req.params['role']);
      const result = await tx.query<{ id: string }>(
        'UPDATE roles SET version=version+1 WHERE code=$1 AND version=$2 RETURNING id',
        [role, data.version],
      );
      requireUpdated(result.rowCount);
      await tx.query('DELETE FROM role_permissions WHERE role_code=$1', [role]);
      for (const permission of new Set(data.permissions))
        await tx.query('INSERT INTO role_permissions VALUES($1,$2)', [
          role,
          permission,
        ]);
      await recordChange(
        tx,
        session.user.id,
        null,
        'role',
        result.rows[0]!.id,
        data.version + 1,
      );
    },
  );
  async function managedUser(
    ctx: Context,
    id: string,
    roles: string[],
    branches: string[],
  ) {
    if (ctx.session.roles.includes('admin')) return;
    const held = new Set(ctx.session.branches.map((b) => b.id));
    const current = (
      await ctx.tx.query<{ branch_id: string }>(
        'SELECT branch_id FROM branch_users WHERE user_id=$1',
        [id],
      )
    ).rows;
    const targetRoles = (
      await ctx.tx.query<{ role_code: string }>(
        'SELECT role_code FROM user_roles WHERE user_id=$1',
        [id],
      )
    ).rows.map((r) => r.role_code);
    const allRoles = [...roles, ...targetRoles];
    const assigned = (
      await ctx.tx.query<{ permission_code: string }>(
        'SELECT DISTINCT permission_code FROM role_permissions WHERE role_code=ANY($1::text[])',
        [allRoles],
      )
    ).rows;
    if (
      allRoles.includes('admin') ||
      branches.length === 0 ||
      branches.some((b) => !held.has(b)) ||
      current.some((b) => !held.has(b.branch_id)) ||
      assigned.some((p) => !ctx.session.permissions.includes(p.permission_code))
    )
      throw new HttpError(
        403,
        'GRANT_FORBIDDEN',
        'You cannot grant or manage access beyond your own permissions and branches.',
      );
  }
  endpoint(
    'get',
    '/users',
    'users.manage',
    async ({ tx, session }) =>
      (
        await tx.query(
          `SELECT u.id,u.username,u.display_name,u.disabled,u.version,ARRAY(SELECT role_code FROM user_roles WHERE user_id=u.id) AS roles,ARRAY(SELECT branch_id FROM branch_users WHERE user_id=u.id) AS branch_ids FROM users u WHERE $1 OR (EXISTS(SELECT 1 FROM branch_users WHERE user_id=u.id AND branch_id=ANY($2::uuid[])) AND NOT EXISTS(SELECT 1 FROM branch_users WHERE user_id=u.id AND NOT(branch_id=ANY($2::uuid[]))) AND NOT EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id AND role_code='admin')) ORDER BY u.username LIMIT 500`,
          [session.roles.includes('admin'), session.branches.map((b) => b.id)],
        )
      ).rows,
  );
  const saveUser = async (ctx: Context) => {
    const { tx, session, req } = ctx;
    const data = userInput.parse(req.body);
    const id = req.params['id'] ? uuid.parse(req.params['id']) : randomUUID();
    await managedUser(ctx, id, data.roles, data.branchIds);
    const branches = await tx.query(
      'SELECT id FROM branches WHERE id=ANY($1::uuid[]) AND archived_at IS NULL',
      [data.branchIds],
    );
    if (branches.rowCount !== new Set(data.branchIds).size)
      throw new HttpError(400, 'INVALID_BRANCH', 'Choose active branches.');
    if (req.params['id']) {
      if (data.password)
        throw new HttpError(400, 'USE_RESET', 'Use the password reset action.');
      requireUpdated(
        (
          await tx.query(
            'UPDATE users SET username=$2,display_name=$3,disabled=$4,version=version+1 WHERE id=$1 AND version=$5',
            [id, data.username, data.displayName, data.disabled, data.version],
          )
        ).rowCount,
      );
    } else {
      if (!data.password)
        throw new HttpError(
          400,
          'PASSWORD_REQUIRED',
          'Supply an initial password.',
        );
      await tx.query(
        'INSERT INTO users(id,username,display_name,password_hash,disabled) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          data.username,
          data.displayName,
          await hashPassword(data.password),
          data.disabled,
        ],
      );
    }
    await tx.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
    await tx.query('DELETE FROM branch_users WHERE user_id=$1', [id]);
    for (const role of new Set(data.roles))
      await tx.query('INSERT INTO user_roles VALUES($1,$2)', [id, role]);
    for (const branch of new Set(data.branchIds))
      await tx.query('INSERT INTO branch_users VALUES($1,$2)', [id, branch]);
    await recordChange(
      tx,
      session.user.id,
      null,
      'user',
      id,
      req.params['id'] ? (data.version ?? 0) + 1 : 1,
    );
    return { id };
  };
  endpoint('post', '/users', 'users.manage', saveUser);
  endpoint('put', '/users/:id', 'users.manage', saveUser);
  endpoint(
    'post',
    '/users/:id/reset',
    'users.manage',
    async ({ tx, session, req }) => {
      if (!session.roles.includes('admin'))
        throw new HttpError(
          403,
          'FORBIDDEN',
          'An administrator must reset passwords.',
        );
      const id = uuid.parse(req.params['id']);
      const data = z.object({ password, version }).strict().parse(req.body);
      requireUpdated(
        (
          await tx.query(
            'UPDATE users SET password_hash=$2,must_change_password=true,version=version+1 WHERE id=$1 AND version=$3',
            [id, await hashPassword(data.password), data.version],
          )
        ).rowCount,
      );
      await recordChange(
        tx,
        session.user.id,
        null,
        'user',
        id,
        data.version + 1,
      );
    },
  );
  endpoint('get', '/login-history', 'history.read', async ({ tx, session }) => {
    if (!session.roles.includes('admin'))
      return (
        await tx.query(
          'SELECT id,success,occurred_at FROM login_logs WHERE user_id=$1 ORDER BY occurred_at DESC LIMIT 100',
          [session.user.id],
        )
      ).rows;
    return (
      await tx.query(
        'SELECT l.id,l.user_id,u.username,l.success,l.occurred_at FROM login_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.occurred_at DESC LIMIT 100',
      )
    ).rows;
  });
  endpoint('get', '/branches', undefined, async ({ tx, session }) =>
    session.permissions.includes('branches.manage')
      ? (
          await tx.query(
            'SELECT id,code,name,version,archived_at IS NOT NULL AS archived FROM branches ORDER BY code',
          )
        ).rows
      : session.branches,
  );
  endpoint(
    'post',
    '/branches',
    'branches.manage',
    async ({ tx, session, req }) => {
      const data = branchInput.parse(req.body);
      const installationId = (
        await tx.query<{ id: string }>(
          'SELECT id FROM installations WHERE singleton',
        )
      ).rows[0]!.id;
      const id = await registerBranch(tx, {
        installationId,
        code: data.code,
        name: data.name,
        actorId: session.user.id,
        requestId: randomUUID(),
      });
      if (data.archived)
        await tx.query('UPDATE branches SET archived_at=now() WHERE id=$1', [
          id,
        ]);
      // New branch access is explicitly assigned; creation does not grant other users access.
      await tx.query('INSERT INTO branch_users VALUES($1,$2)', [
        session.user.id,
        id,
      ]);
      return { id };
    },
  );
  endpoint(
    'put',
    '/branches/:branchId',
    'branches.manage',
    async ({ tx, session, req, branchId }) => {
      const data = branchInput.parse(req.body);
      const old = requireFound(
        (
          await tx.query<{ code: string }>(
            'SELECT code FROM branches WHERE id=$1',
            [branchId],
          )
        ).rows[0],
      );
      if (old.code !== data.code)
        throw new HttpError(
          400,
          'IMMUTABLE_CODE',
          'Branch codes cannot change.',
        );
      requireUpdated(
        (
          await tx.query(
            'UPDATE branches SET name=$2,archived_at=CASE WHEN $3 THEN now() ELSE NULL END,version=version+1 WHERE id=$1 AND version=$4',
            [branchId, data.name, data.archived, data.version],
          )
        ).rowCount,
      );
      await recordChange(
        tx,
        session.user.id,
        branchId,
        'branch',
        branchId!,
        data.version! + 1,
      );
    },
  );
  endpoint('get', '/settings/business', 'settings.global', async ({ tx }) =>
    requireFound(
      (await tx.query('SELECT value,version FROM business_settings')).rows[0],
    ),
  );
  endpoint(
    'put',
    '/settings/business',
    'settings.global',
    async ({ tx, session, req }) => {
      const { version: expected, ...value } = businessInput.parse(req.body);
      const updated = await tx.query<{ id: string }>(
        'UPDATE business_settings SET value=$1,version=version+1 WHERE version=$2 RETURNING id',
        [value, expected],
      );
      requireUpdated(updated.rowCount);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO settings_history(id,branch_id,actor_id,version,value) VALUES($1,NULL,$2,$3,$4)',
        [id, session.user.id, expected + 1, value],
      );
      await recordChange(
        tx,
        session.user.id,
        null,
        'settings',
        updated.rows[0]!.id,
        expected + 1,
      );
    },
  );
  endpoint(
    'get',
    '/settings/business/history',
    'settings.global',
    async ({ tx }) =>
      (
        await tx.query(
          'SELECT id,version,value,occurred_at FROM settings_history WHERE branch_id IS NULL ORDER BY occurred_at DESC LIMIT 100',
        )
      ).rows,
  );
  endpoint(
    'get',
    '/branches/:branchId/settings',
    'settings.manage',
    async ({ tx, branchId }) =>
      (
        await tx.query(
          'SELECT value,version FROM branch_settings WHERE branch_id=$1',
          [branchId],
        )
      ).rows[0] ?? { value: {}, version: 1 },
  );
  endpoint(
    'put',
    '/branches/:branchId/settings',
    'settings.manage',
    async ({ tx, session, req, branchId }) => {
      const { version: expected, ...value } = branchSettingsInput.parse(
        req.body,
      );
      await tx.query(
        'INSERT INTO branch_settings(branch_id) VALUES($1) ON CONFLICT DO NOTHING',
        [branchId],
      );
      const updated = await tx.query<{ id: string }>(
        'UPDATE branch_settings SET value=$2,version=version+1 WHERE branch_id=$1 AND version=$3 RETURNING id',
        [branchId, value, expected],
      );
      requireUpdated(updated.rowCount);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO settings_history VALUES($1,$2,$3,$4,$5,now())',
        [id, branchId, session.user.id, expected + 1, value],
      );
      await recordChange(
        tx,
        session.user.id,
        branchId,
        'settings',
        updated.rows[0]!.id,
        expected + 1,
      );
    },
  );
  endpoint(
    'get',
    '/branches/:branchId/settings/history',
    'settings.manage',
    async ({ tx, branchId }) =>
      (
        await tx.query(
          'SELECT id,version,value,occurred_at FROM settings_history WHERE branch_id=$1 ORDER BY occurred_at DESC LIMIT 100',
          [branchId],
        )
      ).rows,
  );
  endpoint(
    'get',
    '/branches/:branchId/registers',
    'settings.manage',
    async ({ tx, branchId }) => ({
      terminals: (
        await tx.query(
          'SELECT id,code FROM terminals WHERE branch_id=$1 ORDER BY code',
          [branchId],
        )
      ).rows,
      registers: (
        await tx.query(
          'SELECT id,terminal_id,code,archived,version FROM registers WHERE branch_id=$1 ORDER BY code',
          [branchId],
        )
      ).rows,
    }),
  );
  endpoint(
    'post',
    '/branches/:branchId/terminals',
    'settings.manage',
    async ({ tx, session, req, branchId }) => {
      const data = z.object({ code }).strict().parse(req.body);
      const installationId = (
        await tx.query<{ id: string }>('SELECT id FROM installations')
      ).rows[0]!.id;
      return {
        id: await registerTerminal(tx, {
          installationId,
          branchId: branchId!,
          code: data.code,
          actorId: session.user.id,
          requestId: randomUUID(),
        }),
      };
    },
  );
  const saveRegister = async ({ tx, session, req, branchId }: Context) => {
    const data = z
      .object({
        code,
        terminalId: uuid,
        archived: z.boolean().default(false),
        version: version.optional(),
      })
      .strict()
      .parse(req.body);
    requireFound(
      (
        await tx.query(
          'SELECT id FROM terminals WHERE id=$1 AND branch_id=$2',
          [data.terminalId, branchId],
        )
      ).rows[0],
    );
    const id = req.params['id'] ? uuid.parse(req.params['id']) : randomUUID();
    if (req.params['id'])
      requireUpdated(
        (
          await tx.query(
            'UPDATE registers SET code=$3,terminal_id=$4,archived=$5,version=version+1 WHERE id=$1 AND branch_id=$2 AND version=$6',
            [
              id,
              branchId,
              data.code,
              data.terminalId,
              data.archived,
              data.version,
            ],
          )
        ).rowCount,
      );
    else
      await tx.query(
        'INSERT INTO registers(id,branch_id,terminal_id,code,archived) VALUES($1,$2,$3,$4,$5)',
        [id, branchId, data.terminalId, data.code, data.archived],
      );
    await recordChange(
      tx,
      session.user.id,
      branchId,
      'register',
      id,
      req.params['id'] ? data.version! + 1 : 1,
    );
    return { id };
  };
  endpoint(
    'post',
    '/branches/:branchId/registers',
    'settings.manage',
    saveRegister,
  );
  endpoint(
    'put',
    '/branches/:branchId/registers/:id',
    'settings.manage',
    saveRegister,
  );
  installCatalog(endpoint);
  return router;
}
