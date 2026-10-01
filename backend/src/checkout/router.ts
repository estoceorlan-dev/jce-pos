import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  cartInput,
  cartAction,
  discountApproval,
  checkoutInput,
  registerOpenInput,
  printInput,
  uuid,
  version,
  paginationSchema,
} from '@jce/shared';
import type { Context, Endpoint } from '../management/router.js';
import { idempotentInTransaction } from '../db/idempotency.js';
import type { Json } from '../db/canonical.js';
import { verifyPassword } from '../auth/service.js';
import { conflict, installation } from '../inventory/ledger.js';
import { HttpError, requireFound } from '../management/common.js';
import {
  approveDiscount,
  cartTransition,
  checkoutEvent,
  configuration,
  getCart,
  openRegister,
  postSale,
  productSql,
  saleDetail,
  saveCart,
} from './service.js';
const base = '/branches/:branchId/checkout';
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
      operation: `checkout.${operation}`,
      key,
    },
    { actorId: ctx.session.user.id, branchId: ctx.branchId, data },
    work,
  );
}
export function installCheckout(endpoint: Endpoint) {
  endpoint(
    'get',
    `${base}/options`,
    'checkout.use',
    async ({ tx, branchId, session, req }) => {
      const d = z
        .object({
          q: z.string().max(100).default(''),
          customerQ: z.string().max(100).default(''),
        })
        .strict()
        .parse(req.query);
      const variants = (
        await tx.query(
          `${productSql} AND (v.sku ILIKE $2 OR p.name ILIKE $2 OR EXISTS(SELECT 1 FROM product_barcodes b WHERE b.variant_id=v.id AND b.barcode=$3)) ORDER BY v.sku LIMIT 50`,
          [branchId, `%${d.q}%`, d.q],
        )
      ).rows;
      const exact = (
        await tx.query(
          'SELECT variant_id id FROM product_barcodes WHERE barcode=$1 UNION SELECT id FROM product_variants WHERE sku=$1',
          [d.q],
        )
      ).rows.map((r) => r.id as string);
      const customers = (
        await tx.query(
          'SELECT id,name FROM customers WHERE branch_id=$1 AND NOT archived AND name ILIKE $2 ORDER BY name,id LIMIT 50',
          [branchId, `%${d.customerQ}%`],
        )
      ).rows;
      const registers = (
        await tx.query(
          'SELECT r.id,r.code,t.code terminal FROM registers r JOIN terminals t ON t.id=r.terminal_id WHERE r.branch_id=$1 AND NOT r.archived ORDER BY r.code',
          [branchId],
        )
      ).rows;
      const sessions = (
        await tx.query(
          "SELECT s.id,s.opening_float,s.opened_at,r.code register,t.code terminal,(COALESCE((SELECT sum(amount) FROM register_cash_entries e WHERE e.session_id=s.id),0)+COALESCE((SELECT sum(CASE WHEN m.kind='paid_in' THEN m.amount ELSE -m.amount END) FROM cash_movements m WHERE m.session_id=s.id),0)-COALESCE((SELECT sum(p.amount) FROM refund_payments p JOIN sales_returns sr ON sr.id=p.return_id WHERE sr.session_id=s.id AND p.method='cash'),0))::text expected_cash FROM register_sessions s JOIN registers r ON r.id=s.register_id JOIN terminals t ON t.id=s.terminal_id WHERE s.branch_id=$1 AND s.actor_id=$2 AND s.status='open' ORDER BY s.opened_at,s.id",
          [branchId, session.user.id],
        )
      ).rows;
      let setupError = '';
      try {
        await configuration(tx, branchId!);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        setupError = e.message;
      }
      return { variants, exact, customers, registers, sessions, setupError };
    },
  );
  endpoint('post', `${base}/sessions`, 'checkout.use', (ctx) => {
    const d = registerOpenInput.parse(ctx.req.body);
    return once(ctx, 'session_open', d.requestKey, d, () =>
      openRegister(
        ctx.tx,
        ctx.branchId!,
        ctx.session.user.id,
        d.registerId,
        d.openingFloat,
      ),
    );
  });
  endpoint(
    'get',
    `${base}/carts`,
    'checkout.use',
    async ({ tx, branchId, session, req }) => {
      const d = paginationSchema.parse(req.query);
      const rows = (
        await tx.query(
          `SELECT c.id,c.actor_id,c.version,c.status,c.quote->>'customer' customer,c.quote->>'total' total,c.quote->>'discount' discount,u.display_name cashier,c.updated_at FROM checkout_carts c JOIN users u ON u.id=c.actor_id WHERE c.branch_id=$1 AND (c.actor_id=$2 OR $3) AND c.status IN ('active','held') ORDER BY c.updated_at DESC,c.id LIMIT $4 OFFSET $5`,
          [
            branchId,
            session.user.id,
            session.permissions.includes('checkout.approve'),
            d.limit + 1,
            (d.page - 1) * d.limit,
          ],
        )
      ).rows;
      return { rows: rows.slice(0, d.limit), hasMore: rows.length > d.limit };
    },
  );
  endpoint(
    'get',
    `${base}/carts/:id`,
    'checkout.use',
    async ({ tx, branchId, session, req }) => {
      const cart = await getCart(tx, branchId!, uuid.parse(req.params['id']));
      if (
        cart.actor_id !== session.user.id &&
        !session.permissions.includes('checkout.approve')
      )
        throw new HttpError(
          403,
          'CART_FORBIDDEN',
          'This cart belongs to another cashier.',
        );
      const approval =
        (
          await tx.query(
            'SELECT a.id,a.expires_at,u.display_name reviewer FROM checkout_approvals a JOIN users u ON u.id=a.actor_id WHERE a.cart_id=$1 AND a.cart_version=$2 AND a.expires_at>clock_timestamp() ORDER BY a.created_at DESC LIMIT 1',
            [cart.id, cart.version],
          )
        ).rows[0] ?? null;
      const sale =
        (
          await tx.query('SELECT id,number FROM sales WHERE cart_id=$1', [
            cart.id,
          ])
        ).rows[0] ?? null;
      return { cart, approval, sale };
    },
  );
  endpoint('post', `${base}/carts`, 'checkout.use', (ctx) => {
    const d = z
      .object({ requestKey: uuid, cart: cartInput })
      .strict()
      .parse(ctx.req.body);
    return once(ctx, 'cart_create', d.requestKey, d.cart, () =>
      saveCart(ctx.tx, ctx.branchId!, ctx.session.user.id, d.cart),
    );
  });
  endpoint('put', `${base}/carts/:id`, 'checkout.use', (ctx) => {
    const d = z
      .object({ version, cart: cartInput })
      .strict()
      .parse(ctx.req.body);
    return saveCart(ctx.tx, ctx.branchId!, ctx.session.user.id, d.cart, {
      id: uuid.parse(ctx.req.params['id']),
      version: d.version,
    });
  });
  for (const action of ['hold', 'resume', 'cancel'] as const)
    endpoint('post', `${base}/carts/:id/${action}`, 'checkout.use', (ctx) => {
      const d = cartAction.parse(ctx.req.body),
        id = uuid.parse(ctx.req.params['id']);
      return once(
        ctx,
        `cart_${action}`,
        d.requestKey,
        { id, version: d.version },
        () =>
          cartTransition(
            ctx.tx,
            ctx.branchId!,
            ctx.session.user.id,
            id,
            d.version,
            action,
          ),
      );
    });
  endpoint(
    'post',
    `${base}/carts/:id/approve-discount`,
    'checkout.approve',
    async (ctx) => {
      const d = discountApproval.parse(ctx.req.body),
        id = uuid.parse(ctx.req.params['id']);
      const user = requireFound(
        (
          await ctx.tx.query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE id=$1',
            [ctx.session.user.id],
          )
        ).rows[0],
      );
      if (!(await verifyPassword(user.password_hash, d.password)))
        throw conflict('Password confirmation failed.');
      const started = Date.now();
      const result = await once(
        ctx,
        'discount_approval',
        d.requestKey,
        { id, version: d.version, reason: d.reason },
        () =>
          approveDiscount(
            ctx.tx,
            ctx.branchId!,
            ctx.session.user.id,
            id,
            d.version,
            d.reason,
          ),
      );
      if (Date.now() - started > 300000)
        throw conflict('Approval expired. Review again.');
      return result;
    },
  );
  endpoint('post', `${base}/carts/:id/post`, 'checkout.use', (ctx) => {
    const d = checkoutInput.parse(ctx.req.body),
      id = uuid.parse(ctx.req.params['id']);
    return once(ctx, 'post', d.requestKey, { id, ...d }, () =>
      postSale(ctx.tx, ctx.branchId!, ctx.session.user.id, id, d),
    );
  });
  endpoint(
    'get',
    `${base}/requests/:key`,
    'checkout.use',
    async ({ tx, branchId, session, req }) => {
      const sale =
        (
          await tx.query(
            'SELECT id,number FROM sales WHERE branch_id=$1 AND actor_id=$2 AND request_key=$3',
            [branchId, session.user.id, uuid.parse(req.params['key'])],
          )
        ).rows[0] ?? null;
      return { sale };
    },
  );
  const sales = '/branches/:branchId/sales';
  endpoint('get', sales, 'sales.read', async ({ tx, branchId, req }) => {
    const d = paginationSchema
      .extend({
        q: z.string().max(100).default(''),
        unprinted: z.enum(['true', 'false']).default('false'),
      })
      .parse(req.query);
    const rows = (
      await tx.query(
        `SELECT s.id,s.number,s.posted_at,s.total,s.snapshot->>'customer' customer,s.snapshot->>'cashier' cashier,EXISTS(SELECT 1 FROM receipt_print_events p WHERE p.sale_id=s.id AND p.outcome='confirmed') print_confirmed FROM sales s WHERE s.branch_id=$1 AND (s.number ILIKE $2 OR s.snapshot->>'customer' ILIKE $2) AND ($3=false OR NOT EXISTS(SELECT 1 FROM receipt_print_events p WHERE p.sale_id=s.id AND p.outcome='confirmed')) ORDER BY s.posted_at DESC,s.id DESC LIMIT $4 OFFSET $5`,
        [
          branchId,
          `%${d.q}%`,
          d.unprinted === 'true',
          d.limit + 1,
          (d.page - 1) * d.limit,
        ],
      )
    ).rows;
    return { rows: rows.slice(0, d.limit), hasMore: rows.length > d.limit };
  });
  endpoint('get', `${sales}/:id`, 'sales.read', (ctx) =>
    saleDetail(ctx.tx, ctx.branchId!, uuid.parse(ctx.req.params['id'])),
  );
  endpoint('post', `${sales}/:id/print`, 'sales.read', (ctx) => {
    const d = printInput.parse(ctx.req.body),
      saleId = uuid.parse(ctx.req.params['id']);
    return once(ctx, 'print', d.requestKey, { saleId, ...d }, async () => {
      requireFound(
        (
          await ctx.tx.query(
            'SELECT id FROM sales WHERE id=$1 AND branch_id=$2',
            [saleId, ctx.branchId],
          )
        ).rows[0],
      );
      if (d.attemptId)
        requireFound(
          (
            await ctx.tx.query(
              "SELECT id FROM receipt_print_events WHERE id=$1 AND sale_id=$2 AND actor_id=$3 AND outcome='requested'",
              [d.attemptId, saleId, ctx.session.user.id],
            )
          ).rows[0],
        );
      const id = randomUUID();
      await ctx.tx.query(
        'INSERT INTO receipt_print_events(id,sale_id,actor_id,outcome,attempt_id) VALUES($1,$2,$3,$4,$5)',
        [id, saleId, ctx.session.user.id, d.outcome, d.attemptId],
      );
      await checkoutEvent(
        ctx.tx,
        ctx.branchId!,
        ctx.session.user.id,
        id,
        1,
        'print',
        d.outcome,
      );
      return { id };
    });
  });
}
