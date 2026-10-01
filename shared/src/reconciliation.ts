import { z } from 'zod';
import { uuid } from './management.js';
import { stockQuantity } from './inventory.js';
import { checkoutMoney, tenderInput } from './checkout.js';
const reason = z.string().trim().min(1).max(500);
const signedMoney = z.string().regex(/^-?(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
export const correctionInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('return'),
      sessionId: uuid,
      saleId: uuid,
      reversal: z.boolean(),
      reasonCode: z.enum(['customer_return', 'damaged', 'sale_error']),
      reason,
      lines: z
        .array(
          z
            .object({
              saleItemId: uuid,
              quantity: stockQuantity.refine((v) => /[1-9]/.test(v)),
              condition: z.enum(['sellable', 'damaged', 'quarantined']),
            })
            .strict(),
        )
        .min(1)
        .max(100)
        .refine((v) => new Set(v.map((l) => l.saleItemId)).size === v.length),
      payments: z
        .array(tenderInput)
        .max(3)
        .refine((v) => new Set(v.map((p) => p.method)).size === v.length),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cash'),
      sessionId: uuid,
      movement: z.enum(['paid_in', 'paid_out', 'safe_drop']),
      amount: checkoutMoney.refine((v) => /[1-9]/.test(v)),
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('close'),
      sessionId: uuid,
      counts: z
        .object({
          cash: checkoutMoney,
          card: signedMoney,
          ewallet: signedMoney,
        })
        .strict(),
      reason,
    })
    .strict(),
]);
export type CorrectionInput = z.infer<typeof correctionInput>;
