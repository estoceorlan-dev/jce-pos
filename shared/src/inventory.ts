import { z } from 'zod';
import { uuid, version } from './management.js';

export const stockCondition = z.enum(['sellable', 'damaged', 'quarantined']);
export const stockQuantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/);
export const stockDelta = z.string().regex(/^-?(0|[1-9]\d{0,11})(\.\d{1,6})?$/);
export const stockCost = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/);
export const stockLineInput = z
  .object({
    variantId: uuid,
    condition: stockCondition,
    quantity: stockDelta,
    unitCost: stockCost.default('0'),
  })
  .strict();
export const stockDocumentInput = z
  .object({
    kind: z.enum(['opening', 'adjustment', 'count', 'reconcile']),
    reasonCode: z.enum([
      'OPENING',
      'COUNT_VARIANCE',
      'DAMAGE',
      'LOSS',
      'FOUND',
      'CORRECTION',
      'RECONCILIATION',
    ]),
    note: z.string().trim().min(1).max(500),
    sourceReference: z.string().trim().max(160).default(''),
    sourceDocumentId: uuid.nullable().default(null),
    openingDate: z.iso.date().nullable().default(null),
    lines: z.array(stockLineInput).min(1).max(100),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (
      new Set(d.lines.map((l) => `${l.variantId}:${l.condition}`)).size !==
      d.lines.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate variant and condition.',
        path: ['lines'],
      });
    if (
      d.kind === 'opening' &&
      (!d.openingDate || !d.sourceReference || d.reasonCode !== 'OPENING')
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Opening date, source manifest reference and opening reason are required.',
        path: ['sourceReference'],
      });
    if (d.kind !== 'opening' && d.openingDate)
      ctx.addIssue({
        code: 'custom',
        message: 'Only opening stock has a historical date.',
        path: ['openingDate'],
      });
    if (d.kind === 'count' && d.reasonCode !== 'COUNT_VARIANCE')
      ctx.addIssue({
        code: 'custom',
        message: 'Use count variance reason.',
        path: ['reasonCode'],
      });
    if (d.kind === 'reconcile' && d.reasonCode !== 'RECONCILIATION')
      ctx.addIssue({
        code: 'custom',
        message: 'Use reconciliation reason.',
        path: ['reasonCode'],
      });
    if (d.reasonCode === 'CORRECTION' && !d.sourceDocumentId)
      ctx.addIssue({
        code: 'custom',
        message: 'Link the original document.',
        path: ['sourceDocumentId'],
      });
    if (
      ['opening', 'count'].includes(d.kind) &&
      d.lines.some((l) => l.quantity.startsWith('-'))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Opening and counted quantities cannot be negative.',
        path: ['lines'],
      });
  });
export const stockPostInput = z
  .object({ version, requestKey: uuid, password: z.string().min(1).max(128) })
  .strict();
export const reservationInput = z
  .object({
    requestKey: uuid,
    variantId: uuid,
    quantity: stockQuantity.refine((v) => /[1-9]/.test(v)),
    reference: z.string().trim().min(1).max(160),
  })
  .strict();
export type StockDocumentInput = z.infer<typeof stockDocumentInput>;
export type StockCondition = z.infer<typeof stockCondition>;
