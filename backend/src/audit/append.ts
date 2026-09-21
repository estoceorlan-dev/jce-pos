import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireTransaction, type Transaction } from '../db/transaction.js';

const auditSchema = z
  .object({
    installationId: z.uuid(),
    branchId: z.uuid().nullable(),
    actorId: z.uuid().nullable(),
    requestId: z.uuid(),
    action: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
    entityType: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    entityId: z.uuid(),
    entityVersion: z.number().int().positive(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();
export type AuditEntry = z.infer<typeof auditSchema>;
/** Metadata only. Arbitrary before/after objects, free text and credentials are not accepted. */
export async function appendAudit(
  tx: Transaction,
  input: AuditEntry,
): Promise<string> {
  requireTransaction(tx);
  const entry = auditSchema.parse(input);
  const id = randomUUID();
  await tx.query(
    'INSERT INTO audit_logs (id,installation_id,branch_id,actor_id,request_id,action,entity_type,entity_id,entity_version,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      id,
      entry.installationId,
      entry.branchId,
      entry.actorId,
      entry.requestId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.entityVersion,
      entry.reasonCode ?? null,
    ],
  );
  return id;
}
