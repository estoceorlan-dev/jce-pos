import type pg from 'pg';
import { z } from 'zod';
import { canonicalJson, checksum, type Json } from './canonical.js';
import {
  requireTransaction,
  withTransaction,
  type Transaction,
} from './transaction.js';

const scopeSchema = z
  .object({
    installationId: z.uuid(),
    operation: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
    key: z.uuid(),
  })
  .strict();
export class IdempotencyConflict extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super('Idempotency key was already used with a different request.');
  }
}
/** Authenticate/authorize BEFORE this call, including replays. Include actor/branch in request. */
export async function idempotent<T extends Json>(
  pool: pg.Pool,
  scope: z.infer<typeof scopeSchema>,
  request: Json,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, (tx) =>
    idempotentInTransaction(tx, scope, request, work),
  );
}

/** Use inside an already authorized transaction; never opens a second connection. */
export async function idempotentInTransaction<T extends Json>(
  tx: Transaction,
  scope: z.infer<typeof scopeSchema>,
  request: Json,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  requireTransaction(tx);
  const { installationId, operation, key } = scopeSchema.parse(scope);
  const hash = checksum(request);
  const claimed = await tx.query(
    'INSERT INTO idempotency_requests (installation_id, operation, request_key, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING request_key',
    [installationId, operation, key, hash],
  );
  if (!claimed.rowCount) {
    const prior = await tx.query<{
      request_hash: string;
      response: T;
      completed_at: Date | null;
    }>(
      'SELECT request_hash, response, completed_at FROM idempotency_requests WHERE installation_id=$1 AND operation=$2 AND request_key=$3',
      [installationId, operation, key],
    );
    const row = prior.rows[0];
    if (!row || !row.completed_at)
      throw new Error('Incomplete idempotency history.');
    if (row.request_hash !== hash) throw new IdempotencyConflict();
    return row.response;
  }
  const response = await work(tx);
  const encoded = canonicalJson(response);
  await tx.query(
    'UPDATE idempotency_requests SET response=$4::jsonb, completed_at=now() WHERE installation_id=$1 AND operation=$2 AND request_key=$3',
    [installationId, operation, key, encoded],
  );
  return JSON.parse(encoded) as T;
}
