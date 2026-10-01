import { z } from 'zod';
import { uuid, version } from './management.js';
import { stockQuantity, stockCondition } from './inventory.js';
const positiveQuantity = stockQuantity.refine((v) => /[1-9]/.test(v));
const note = z.string().trim().min(1).max(500);
export const transferStatuses = [
  'draft',
  'pending',
  'approved',
  'in_transit',
  'partially_received',
  'received',
  'rejected',
  'cancelled',
] as const;
export const transferInput = z
  .object({
    destinationBranchId: uuid,
    returnOfId: uuid.nullable().default(null),
    note,
    lines: z
      .array(z.object({ variantId: uuid, quantity: positiveQuantity }).strict())
      .min(1)
      .max(100)
      .refine((v) => new Set(v.map((l) => l.variantId)).size === v.length),
  })
  .strict();
export const transferAction = z
  .object({ requestKey: uuid, version, note })
  .strict();
export const transferApproval = transferAction.extend({
  password: z.string().min(1).max(128),
});
export const transferReceiptInput = transferAction.extend({
  lines: z
    .array(
      z
        .object({
          transferItemId: uuid,
          quantity: positiveQuantity,
          condition: stockCondition,
        })
        .strict(),
    )
    .min(1)
    .max(100)
    .refine((v) => new Set(v.map((l) => l.transferItemId)).size === v.length),
});
export const transferDiscrepancyInput = transferAction.extend({
  reasonCode: z.enum(['MISSING', 'DAMAGED', 'RETURN_TO_SOURCE']),
  lines: z
    .array(
      z
        .object({
          transferItemId: uuid,
          quantity: positiveQuantity,
          resolution: z.enum(['lost', 'return_to_source']),
          condition: stockCondition,
        })
        .strict(),
    )
    .min(1)
    .max(100)
    .refine((v) => new Set(v.map((l) => l.transferItemId)).size === v.length),
});
export type TransferInput = z.infer<typeof transferInput>;
export type TransferReceiptInput = z.infer<typeof transferReceiptInput>;
export type TransferDiscrepancyInput = z.infer<typeof transferDiscrepancyInput>;
