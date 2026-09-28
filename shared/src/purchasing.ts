import { z } from 'zod';
import { uuid, version } from './management.js';
import { stockCost, stockQuantity, stockCondition } from './inventory.js';
const positive = stockQuantity.refine((v) => /[1-9]/.test(v));
const rate = z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/);
export const purchaseOrderInput = z
  .object({
    supplierId: uuid,
    note: z.string().trim().min(1).max(500),
    lines: z
      .array(
        z
          .object({
            variantId: uuid,
            quantity: positive,
            unitCost: stockCost,
            discountRate: rate,
            taxRate: rate,
            taxInclusive: z.boolean(),
            capitalizeTax: z.boolean(),
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
export const purchaseReceiptInput = z
  .object({
    orderId: uuid,
    supplierReference: z.string().trim().min(1).max(160),
    deliveryReference: z.string().trim().min(1).max(160),
    note: z.string().trim().max(500),
    lines: z
      .array(
        z
          .object({
            orderItemId: uuid,
            quantity: positive,
            condition: stockCondition,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (d) => new Set(d.lines.map((l) => l.orderItemId)).size === d.lines.length,
    { message: 'Use each order line once per delivery.', path: ['lines'] },
  );
export const purchasingTransition = z
  .object({
    version,
    requestKey: uuid,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const purchasingApproval = purchasingTransition.extend({
  password: z.string().min(1).max(128),
});
export const purchasePost = z.object({ version, requestKey: uuid }).strict();
export const purchaseReversalInput = z
  .object({
    requestKey: uuid,
    originalId: uuid,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type PurchaseOrderInput = z.infer<typeof purchaseOrderInput>;
export type PurchaseReceiptInput = z.infer<typeof purchaseReceiptInput>;
