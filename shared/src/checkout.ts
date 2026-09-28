import { z } from 'zod';
import { uuid, version } from './management.js';
import { stockQuantity } from './inventory.js';
export const checkoutMoney = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
export const cartInput = z
  .object({
    sessionId: uuid,
    customerId: uuid.nullable(),
    lines: z
      .array(
        z
          .object({
            variantId: uuid,
            quantity: stockQuantity.refine((v) => /[1-9]/.test(v)),
            discount: checkoutMoney,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (d) => new Set(d.lines.map((l) => l.variantId)).size === d.lines.length,
    { message: 'Use each variant once.', path: ['lines'] },
  );
export const cartAction = z.object({ version, requestKey: uuid }).strict();
export const discountApproval = cartAction.extend({
  password: z.string().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
});
export const tenderInput = z
  .object({
    method: z.enum(['cash', 'card', 'ewallet']),
    amount: checkoutMoney.refine((v) => /[1-9]/.test(v)),
    reference: z.string().trim().max(160),
  })
  .strict();
export const checkoutInput = cartAction.extend({
  payments: z
    .array(tenderInput)
    .min(1)
    .max(3)
    .refine((p) => new Set(p.map((v) => v.method)).size === p.length),
});
export const registerOpenInput = z
  .object({ requestKey: uuid, registerId: uuid, openingFloat: checkoutMoney })
  .strict();
export const printInput = z
  .object({
    requestKey: uuid,
    outcome: z.enum(['requested', 'confirmed', 'failed']),
    attemptId: uuid.nullable(),
  })
  .strict()
  .refine((v) => (v.outcome === 'requested') === (v.attemptId === null));
export type CartInput = z.infer<typeof cartInput>;
export type CheckoutInput = z.infer<typeof checkoutInput>;
export type TenderInput = z.infer<typeof tenderInput>;
