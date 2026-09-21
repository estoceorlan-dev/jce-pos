import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, checksum } from '../db/canonical.js';
import { requireTransaction, type Transaction } from '../db/transaction.js';

// Each later module must introduce an explicit, reviewed event schema. No
// arbitrary request-body snapshots, customer contact details or credentials.
const eventSchema = z.discriminatedUnion('eventType', [
  z
    .object({
      eventType: z.literal('master.changed'),
      aggregateType: z.literal('master'),
      payload: z
        .object({
          entityId: z.uuid(),
          kind: z.enum([
            'user',
            'role',
            'branch',
            'register',
            'settings',
            'category',
            'brand',
            'unit',
            'tax',
            'variant',
            'price',
            'supplier',
            'customer',
            'import',
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      eventType: z.literal('installation.created'),
      aggregateType: z.literal('installation'),
      payload: z.object({ installationId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      eventType: z.literal('branch.created'),
      aggregateType: z.literal('branch'),
      payload: z.object({ branchId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      eventType: z.literal('terminal.created'),
      aggregateType: z.literal('terminal'),
      payload: z.object({ terminalId: z.uuid(), branchId: z.uuid() }).strict(),
    })
    .strict(),
]);
export type FoundationEvent = z.infer<typeof eventSchema>;
const contextSchema = z
  .object({
    installationId: z.uuid(),
    branchId: z.uuid().nullable(),
    aggregateId: z.uuid(),
    aggregateVersion: z.number().int().positive(),
  })
  .strict();
export type EventContext = z.infer<typeof contextSchema>;
export async function appendOutbox(
  tx: Transaction,
  context: EventContext,
  input: FoundationEvent,
): Promise<string> {
  requireTransaction(tx);
  const scope = contextSchema.parse(context);
  const event = eventSchema.parse(input);
  const entityId =
    event.eventType === 'master.changed'
      ? event.payload.entityId
      : event.eventType === 'installation.created'
        ? event.payload.installationId
        : event.eventType === 'branch.created'
          ? event.payload.branchId
          : event.payload.terminalId;
  if (
    entityId !== scope.aggregateId ||
    (event.eventType === 'installation.created' &&
      (scope.branchId !== null || entityId !== scope.installationId)) ||
    (event.eventType === 'branch.created' && scope.branchId !== entityId) ||
    (event.eventType === 'terminal.created' &&
      scope.branchId !== event.payload.branchId)
  )
    throw new Error('Event scope does not match its payload.');
  const envelope = {
    eventId: randomUUID(),
    ...scope,
    schemaVersion: 1,
    ...event,
    occurredAt: new Date().toISOString(),
  };
  const digest = checksum(envelope);
  await tx.query(
    'INSERT INTO sync_queue (event_id,installation_id,branch_id,aggregate_type,aggregate_id,aggregate_version,schema_version,event_type,payload,occurred_at,checksum) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)',
    [
      envelope.eventId,
      scope.installationId,
      scope.branchId,
      event.aggregateType,
      scope.aggregateId,
      scope.aggregateVersion,
      1,
      event.eventType,
      canonicalJson(event.payload),
      envelope.occurredAt,
      digest,
    ],
  );
  return envelope.eventId;
}
