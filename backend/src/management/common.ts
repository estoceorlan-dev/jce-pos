import { randomUUID } from 'node:crypto';
import type { Transaction } from '../db/transaction.js';
import { appendAudit } from '../audit/append.js';
import { appendOutbox } from '../sync/outbox.js';
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireFound<T>(value: T | undefined | null): T {
  if (!value) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  return value;
}
export function requireUpdated(count: number | null) {
  if (!count)
    throw new HttpError(
      409,
      'CONFLICT',
      'This record changed. Reload before saving.',
    );
}
export type ChangeKind =
  | 'user'
  | 'role'
  | 'branch'
  | 'register'
  | 'settings'
  | 'category'
  | 'brand'
  | 'unit'
  | 'tax'
  | 'variant'
  | 'price'
  | 'supplier'
  | 'customer'
  | 'import';
export async function recordChange(
  tx: Transaction,
  actorId: string | null,
  branchId: string | null,
  kind: ChangeKind,
  id: string,
  version: number,
) {
  const installationId = (
    await tx.query<{ id: string }>(
      'SELECT id FROM installations WHERE singleton',
    )
  ).rows[0]?.id;
  if (!installationId)
    throw new HttpError(
      503,
      'SETUP_REQUIRED',
      'Initialize the installation first.',
    );
  await appendAudit(tx, {
    installationId,
    branchId,
    actorId,
    requestId: randomUUID(),
    action: `${kind}.changed`,
    entityType: kind,
    entityId: id,
    entityVersion: version,
  });
  await appendOutbox(
    tx,
    { installationId, branchId, aggregateId: id, aggregateVersion: version },
    {
      eventType: 'master.changed',
      aggregateType: 'master',
      payload: { entityId: id, kind },
    },
  );
}
