import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { appendAudit } from '../audit/append.js';
import { appendOutbox } from '../sync/outbox.js';
import {
  requireTransaction,
  withTransaction,
  type Transaction,
} from './transaction.js';

export async function initializeInstallation(pool: pg.Pool): Promise<string> {
  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(74012002)');
    const existing = await tx.query<{ id: string }>(
      'SELECT id FROM installations WHERE singleton',
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    await tx.query('INSERT INTO installations (id) VALUES ($1)', [id]);
    await appendAudit(tx, {
      installationId: id,
      branchId: null,
      actorId: null,
      requestId: randomUUID(),
      action: 'installation.created',
      entityType: 'installation',
      entityId: id,
      entityVersion: 1,
    });
    await appendOutbox(
      tx,
      {
        installationId: id,
        branchId: null,
        aggregateId: id,
        aggregateVersion: 1,
      },
      {
        eventType: 'installation.created',
        aggregateType: 'installation',
        payload: { installationId: id },
      },
    );
    return id;
  });
}
const code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/);
const branchSchema = z
  .object({
    installationId: z.uuid(),
    code,
    name: z.string().trim().min(1).max(160),
    actorId: z.uuid().nullable(),
    requestId: z.uuid(),
  })
  .strict();
/** Internal service; L3 must check authenticated branch permissions before calling. */
export async function registerBranch(
  tx: Transaction,
  input: z.infer<typeof branchSchema>,
): Promise<string> {
  requireTransaction(tx);
  const data = branchSchema.parse(input);
  const id = randomUUID();
  await tx.query('INSERT INTO branches (id,code,name) VALUES ($1,$2,$3)', [
    id,
    data.code,
    data.name,
  ]);
  await tx.query(
    'INSERT INTO branch_ownership (branch_id,installation_id) VALUES ($1,$2)',
    [id, data.installationId],
  );
  await appendAudit(tx, {
    installationId: data.installationId,
    branchId: id,
    actorId: data.actorId,
    requestId: data.requestId,
    action: 'branch.created',
    entityType: 'branch',
    entityId: id,
    entityVersion: 1,
  });
  await appendOutbox(
    tx,
    {
      installationId: data.installationId,
      branchId: id,
      aggregateId: id,
      aggregateVersion: 1,
    },
    {
      eventType: 'branch.created',
      aggregateType: 'branch',
      payload: { branchId: id },
    },
  );
  return id;
}
const terminalSchema = z
  .object({
    installationId: z.uuid(),
    branchId: z.uuid(),
    code,
    actorId: z.uuid().nullable(),
    requestId: z.uuid(),
  })
  .strict();
export async function registerTerminal(
  tx: Transaction,
  input: z.infer<typeof terminalSchema>,
): Promise<string> {
  requireTransaction(tx);
  const data = terminalSchema.parse(input);
  const id = randomUUID();
  await tx.query(
    'INSERT INTO terminals (id,branch_id,installation_id,code) VALUES ($1,$2,$3,$4)',
    [id, data.branchId, data.installationId, data.code],
  );
  await appendAudit(tx, {
    installationId: data.installationId,
    branchId: data.branchId,
    actorId: data.actorId,
    requestId: data.requestId,
    action: 'terminal.created',
    entityType: 'terminal',
    entityId: id,
    entityVersion: 1,
  });
  await appendOutbox(
    tx,
    {
      installationId: data.installationId,
      branchId: data.branchId,
      aggregateId: id,
      aggregateVersion: 1,
    },
    {
      eventType: 'terminal.created',
      aggregateType: 'terminal',
      payload: { terminalId: id, branchId: data.branchId },
    },
  );
  return id;
}
