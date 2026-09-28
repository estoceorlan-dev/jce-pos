import { z } from 'zod';
import {
  paginationSchema,
  purchaseOrderInput,
  purchaseReceiptInput,
  purchaseReversalInput,
  purchasingApproval,
  purchasingTransition,
  purchasePost,
  uuid,
  version,
} from '@jce/shared';
import type { Context, Endpoint } from '../management/router.js';
import { requireFound } from '../management/common.js';
import { verifyPassword } from '../auth/service.js';
import { idempotentInTransaction } from '../db/idempotency.js';
import type { Json } from '../db/canonical.js';
import { conflict, installation } from '../inventory/ledger.js';
import {
  cancelReceipt,
  createReversal,
  orderDetail,
  postReceipt,
  receiptDetail,
  saveOrder,
  saveReceipt,
  transitionOrder,
} from './service.js';
const base = '/branches/:branchId/purchasing';
async function once<T extends Json>(
  ctx: Context,
  operation: string,
  key: string,
  data: Json,
  work: () => Promise<T>,
) {
  return idempotentInTransaction(
    ctx.tx,
    {
      installationId: await installation(ctx.tx, ctx.branchId!),
      operation: `purchasing.${operation}`,
      key,
    },
    { actorId: ctx.session.user.id, branchId: ctx.branchId, data },
    work,
  );
}
async function confirmed<T>(
  ctx: Context,
  password: string,
  work: () => Promise<T>,
) {
  const row = requireFound(
    (
      await ctx.tx.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id=$1',
        [ctx.session.user.id],
      )
    ).rows[0],
  );
  if (!(await verifyPassword(row.password_hash, password)))
    throw conflict('Password confirmation failed.');
  const start = Date.now();
  const result = await work();
  if (Date.now() - start > 300000)
    throw conflict('Approval expired. Review and try again.');
  return result;
}
export function installPurchasing(endpoint: Endpoint) {
  endpoint(
    'get',
    `${base}/options`,
    'purchasing.read',
    async ({ tx, branchId, req }) => {
      const { q, supplierQ } = z
        .object({
          q: z.string().max(100).default(''),
          supplierQ: z.string().max(100).default(''),
        })
        .strict()
        .parse(req.query);
      const suppliers = (
        await tx.query(
          'SELECT id,name FROM suppliers WHERE branch_id=$1 AND NOT archived AND name ILIKE $2 ORDER BY name,id LIMIT 100',
          [branchId, `%${supplierQ}%`],
        )
      ).rows;
      const variants = (
        await tx.query(
          'SELECT v.id,v.sku,p.name,v.conversion,u.name unit FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id WHERE NOT v.archived AND NOT p.archived AND NOT u.archived AND (v.sku ILIKE $1 OR p.name ILIKE $1) ORDER BY v.sku LIMIT 100',
          [`%${q}%`],
        )
      ).rows;
      return { suppliers, variants };
    },
  );
  endpoint(
    'get',
    `${base}/orders`,
    'purchasing.read',
    async ({ tx, branchId, req }) => {
      const d = paginationSchema
        .extend({
          q: z.string().max(100).default(''),
          status: z
            .enum([
              'all',
              'outstanding',
              'draft',
              'submitted',
              'approved',
              'partially_received',
              'received',
              'rejected',
              'cancelled',
              'closed',
            ])
            .default('all'),
          supplierId: uuid.optional(),
        })
        .parse(req.query);
      const rows = (
        await tx.query(
          `SELECT id,number,status,version,note,created_at,snapshot->>'supplierName' supplier FROM purchase_orders WHERE branch_id=$1 AND ($2='all' OR status=$2 OR ($2='outstanding' AND status IN ('approved','partially_received'))) AND ($3::uuid IS NULL OR supplier_id=$3) AND (number ILIKE $4 OR snapshot->>'supplierName' ILIKE $4) ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6`,
          [
            branchId,
            d.status,
            d.supplierId ?? null,
            `%${d.q}%`,
            d.limit + 1,
            (d.page - 1) * d.limit,
          ],
        )
      ).rows;
      return { rows: rows.slice(0, d.limit), hasMore: rows.length > d.limit };
    },
  );
  endpoint('get', `${base}/orders/:id`, 'purchasing.read', async (ctx) => {
    const id = uuid.parse(ctx.req.params['id']);
    const result = await orderDetail(ctx.tx, ctx.branchId!, id);
    const events = (
      await ctx.tx.query(
        'SELECT e.version,e.action,e.reason,e.occurred_at,u.display_name actor FROM purchase_order_events e JOIN users u ON u.id=e.actor_id WHERE e.order_id=$1 ORDER BY e.version',
        [id],
      )
    ).rows;
    return { ...result, events };
  });
  endpoint('post', `${base}/orders`, 'purchasing.manage', (ctx) => {
    const d = z
      .object({ requestKey: uuid, order: purchaseOrderInput })
      .strict()
      .parse(ctx.req.body);
    return once(ctx, 'order_draft', d.requestKey, d.order, () =>
      saveOrder(ctx.tx, ctx.branchId!, ctx.session.user.id, d.order),
    );
  });
  endpoint('put', `${base}/orders/:id`, 'purchasing.manage', (ctx) => {
    const d = z
      .object({ version, order: purchaseOrderInput })
      .strict()
      .parse(ctx.req.body);
    return saveOrder(ctx.tx, ctx.branchId!, ctx.session.user.id, d.order, {
      id: uuid.parse(ctx.req.params['id']),
      version: d.version,
    });
  });
  for (const action of [
    'submit',
    'approve',
    'reject',
    'cancel',
    'close',
  ] as const) {
    const approval = ['approve', 'reject', 'close'].includes(action);
    endpoint(
      'post',
      `${base}/orders/:id/${action}`,
      approval ? 'purchasing.approve' : 'purchasing.manage',
      async (ctx) => {
        const d = (approval ? purchasingApproval : purchasingTransition).parse(
          ctx.req.body,
        );
        const id = uuid.parse(ctx.req.params['id']);
        const work = () =>
          once(
            ctx,
            `order_${action}`,
            d.requestKey,
            { id, version: d.version, reason: d.reason },
            () =>
              transitionOrder(
                ctx.tx,
                ctx.branchId!,
                ctx.session.user.id,
                id,
                d.version,
                action,
                d.reason,
              ),
          );
        return approval
          ? confirmed(
              ctx,
              purchasingApproval.parse(ctx.req.body).password,
              work,
            )
          : work();
      },
    );
  }
  endpoint(
    'get',
    `${base}/receipts`,
    'purchasing.read',
    async ({ tx, branchId, req }) => {
      const d = paginationSchema
        .extend({ supplierId: uuid.optional(), orderId: uuid.optional() })
        .parse(req.query);
      if (d.supplierId)
        requireFound(
          (
            await tx.query(
              'SELECT id FROM suppliers WHERE id=$1 AND branch_id=$2',
              [d.supplierId, branchId],
            )
          ).rows[0],
        );
      if (d.orderId) await orderDetail(tx, branchId!, d.orderId);
      const args = [branchId, d.supplierId ?? null, d.orderId ?? null];
      const where =
        'branch_id=$1 AND ($2::uuid IS NULL OR supplier_id=$2) AND ($3::uuid IS NULL OR order_id=$3)';
      const rows = (
        await tx.query(
          `SELECT id,number,kind,status,supplier_reference,delivery_reference,net,tax,total,stock_value,posted_at,snapshot->>'supplierName' supplier FROM purchases WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,
          [...args, d.limit + 1, (d.page - 1) * d.limit],
        )
      ).rows;
      const totals = (
        await tx.query(
          `SELECT COALESCE(sum(net),0)::text net,COALESCE(sum(tax),0)::text tax,COALESCE(sum(total),0)::text total,COALESCE(sum(stock_value),0)::text stock_value FROM purchases WHERE ${where} AND status='posted'`,
          args,
        )
      ).rows[0];
      return {
        rows: rows.slice(0, d.limit),
        hasMore: rows.length > d.limit,
        totals,
      };
    },
  );
  endpoint('get', `${base}/receipts/:id`, 'purchasing.read', async (ctx) => {
    const detail = await receiptDetail(
      ctx.tx,
      ctx.branchId!,
      uuid.parse(ctx.req.params['id']),
    );
    const users = (
      await ctx.tx.query(
        'SELECT u.display_name receiver,a.display_name approver FROM purchases p JOIN users u ON u.id=p.actor_id LEFT JOIN users a ON a.id=p.approver_id WHERE p.id=$1',
        [detail.receipt.id],
      )
    ).rows[0];
    return { ...detail, ...users };
  });
  endpoint('post', `${base}/receipts`, 'purchasing.receive', (ctx) => {
    const d = z
      .object({ requestKey: uuid, receipt: purchaseReceiptInput })
      .strict()
      .parse(ctx.req.body);
    return once(ctx, 'receipt_draft', d.requestKey, d.receipt, () =>
      saveReceipt(ctx.tx, ctx.branchId!, ctx.session.user.id, d.receipt),
    );
  });
  endpoint('put', `${base}/receipts/:id`, 'purchasing.receive', (ctx) => {
    const d = z
      .object({ version, receipt: purchaseReceiptInput })
      .strict()
      .parse(ctx.req.body);
    return saveReceipt(ctx.tx, ctx.branchId!, ctx.session.user.id, d.receipt, {
      id: uuid.parse(ctx.req.params['id']),
      version: d.version,
    });
  });
  endpoint('post', `${base}/receipts/:id/post`, 'purchasing.receive', (ctx) => {
    const d = purchasePost.parse(ctx.req.body);
    const id = uuid.parse(ctx.req.params['id']);
    return once(
      ctx,
      'receipt_post',
      d.requestKey,
      { id, version: d.version },
      () =>
        postReceipt(ctx.tx, ctx.branchId!, ctx.session.user.id, id, d.version),
    );
  });
  endpoint(
    'post',
    `${base}/receipts/:id/cancel`,
    'purchasing.receive',
    (ctx) => {
      const d = purchasePost.parse(ctx.req.body);
      const id = uuid.parse(ctx.req.params['id']);
      return once(
        ctx,
        'receipt_cancel',
        d.requestKey,
        { id, version: d.version },
        () =>
          cancelReceipt(
            ctx.tx,
            ctx.branchId!,
            ctx.session.user.id,
            id,
            d.version,
          ),
      );
    },
  );
  endpoint('post', `${base}/reversals`, 'purchasing.receive', (ctx) => {
    const d = purchaseReversalInput.parse(ctx.req.body);
    return once(
      ctx,
      'reversal_draft',
      d.requestKey,
      { originalId: d.originalId, reason: d.reason },
      () =>
        createReversal(
          ctx.tx,
          ctx.branchId!,
          ctx.session.user.id,
          d.originalId,
          d.reason,
        ),
    );
  });
  endpoint(
    'post',
    `${base}/receipts/:id/approve-reversal`,
    'purchasing.approve',
    (ctx) => {
      const d = purchasePost
        .extend({ password: z.string().min(1).max(128) })
        .parse(ctx.req.body);
      const id = uuid.parse(ctx.req.params['id']);
      return confirmed(ctx, d.password, () =>
        once(
          ctx,
          'reversal_post',
          d.requestKey,
          { id, version: d.version },
          () =>
            postReceipt(
              ctx.tx,
              ctx.branchId!,
              ctx.session.user.id,
              id,
              d.version,
              true,
            ),
        ),
      );
    },
  );
}
