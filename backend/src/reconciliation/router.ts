import { z } from 'zod';
import { correctionInput, uuid, paginationSchema } from '@jce/shared';
import type { Context, Endpoint } from '../management/router.js';
import { idempotentInTransaction } from '../db/idempotency.js';
import type { Json } from '../db/canonical.js';
import { installation, conflict } from '../inventory/ledger.js';
import { authorize, verifyPassword } from '../auth/service.js';
import { HttpError } from '../management/common.js';
import {
  actionPermission,
  approvalPermission,
  approveRequest,
  createRequest,
  eligibility,
  getRequest,
  postRequest,
  summary,
  quoteReturn,
} from './service.js';
const base = '/branches/:branchId/reconciliation';
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
      operation: `reconciliation.${operation}`,
      key,
    },
    { actorId: ctx.session.user.id, branchId: ctx.branchId, data },
    work,
  );
}
export function installReconciliation(endpoint: Endpoint) {
  endpoint('post', `${base}/preview-return`, 'returns.use', (ctx) => {
    const d = correctionInput.parse(ctx.req.body);
    if (d.kind !== 'return') throw conflict('A return is required.');
    return quoteReturn(ctx.tx, ctx.branchId!, d, false);
  });
  endpoint('get', `${base}/sales/:id`, 'returns.use', (ctx) =>
    eligibility(ctx.tx, ctx.branchId!, uuid.parse(ctx.req.params['id'])),
  );
  endpoint('get', `${base}/sessions`, 'checkout.use', async (ctx) => {
    const p = paginationSchema.parse(ctx.req.query);
    const rows = (
      await ctx.tx.query(
        `SELECT s.id,s.status,s.opened_at,s.closed_at,s.business_date::text,r.code register,u.display_name cashier FROM register_sessions s JOIN registers r ON r.id=s.register_id JOIN users u ON u.id=s.actor_id WHERE s.branch_id=$1 AND (s.actor_id=$2 OR $3) ORDER BY s.opened_at DESC,s.id LIMIT $4 OFFSET $5`,
        [
          ctx.branchId,
          ctx.session.user.id,
          ctx.session.permissions.includes('cash.approve'),
          p.limit + 1,
          (p.page - 1) * p.limit,
        ],
      )
    ).rows;
    return { rows: rows.slice(0, p.limit), hasMore: rows.length > p.limit };
  });
  endpoint('get', `${base}/sessions/:id`, 'checkout.use', async (ctx) => {
    const s = await summary(
      ctx.tx,
      ctx.branchId!,
      uuid.parse(ctx.req.params['id']),
    );
    if (
      s.session.actor_id !== ctx.session.user.id &&
      !ctx.session.permissions.includes('cash.approve')
    )
      throw new HttpError(
        403,
        'SESSION_FORBIDDEN',
        'This shift belongs to another cashier.',
      );
    const closure =
      (
        await ctx.tx.query(
          'SELECT * FROM register_closures WHERE session_id=$1',
          [s.session.id],
        )
      ).rows[0] ?? null;
    const movements = (
      await ctx.tx.query(
        'SELECT kind,amount,reason,occurred_at FROM cash_movements WHERE session_id=$1 ORDER BY occurred_at,id',
        [s.session.id],
      )
    ).rows;
    return { summary: s, closure, movements };
  });
  endpoint('get', `${base}/requests`, undefined, async (ctx) => {
    const p = paginationSchema.parse(ctx.req.query);
    const rows = (
      await ctx.tx.query(
        `SELECT r.id,r.kind,r.status,r.created_at,r.input->>'reason' reason,u.display_name cashier FROM correction_requests r JOIN users u ON u.id=r.actor_id WHERE r.branch_id=$1 AND (r.actor_id=$2 OR (r.kind='return' AND $3) OR (r.kind<>'return' AND $4)) ORDER BY r.created_at DESC,r.id LIMIT $5 OFFSET $6`,
        [
          ctx.branchId,
          ctx.session.user.id,
          ctx.session.permissions.includes('returns.approve'),
          ctx.session.permissions.includes('cash.approve'),
          p.limit + 1,
          (p.page - 1) * p.limit,
        ],
      )
    ).rows;
    return { rows: rows.slice(0, p.limit), hasMore: rows.length > p.limit };
  });
  endpoint('get', `${base}/requests/:id`, undefined, async (ctx) => {
    const r = await getRequest(
      ctx.tx,
      ctx.branchId!,
      uuid.parse(ctx.req.params['id']),
    );
    authorize(
      ctx.session,
      r.actor_id === ctx.session.user.id
        ? actionPermission(r.input)
        : approvalPermission(r.input),
      ctx.branchId!,
    );
    const approvals = (
      await ctx.tx.query(
        'SELECT a.id,a.expires_at,u.display_name reviewer FROM correction_approvals a JOIN users u ON u.id=a.actor_id WHERE a.request_id=$1 ORDER BY a.created_at DESC',
        [r.id],
      )
    ).rows;
    const result =
      (
        await ctx.tx.query(
          'SELECT number,total FROM sales_returns WHERE id=$1',
          [r.id],
        )
      ).rows[0] ?? null;
    return { request: r, approvals, result };
  });
  endpoint('post', `${base}/requests`, undefined, (ctx) => {
    const d = z
      .object({ requestKey: uuid, input: correctionInput })
      .strict()
      .parse(ctx.req.body);
    authorize(ctx.session, actionPermission(d.input), ctx.branchId!);
    return once(ctx, 'create', d.requestKey, d.input, () =>
      createRequest(ctx.tx, ctx.branchId!, ctx.session.user.id, d.input),
    );
  });
  // Dedicated permission paths apply the existing persisted approval throttle.
  for (const kind of ['return', 'cash'] as const)
    endpoint(
      'post',
      `${base}/requests/:id/approve-${kind}`,
      kind === 'return' ? 'returns.approve' : 'cash.approve',
      async (ctx) => {
        const d = z
            .object({ requestKey: uuid, password: z.string().min(1).max(128) })
            .strict()
            .parse(ctx.req.body),
          id = uuid.parse(ctx.req.params['id']);
        const r = await getRequest(ctx.tx, ctx.branchId!, id);
        if ((r.input.kind === 'return') !== (kind === 'return'))
          throw conflict('Incorrect approval action.');
        const user = (
          await ctx.tx.query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE id=$1',
            [ctx.session.user.id],
          )
        ).rows[0]!;
        if (!(await verifyPassword(user.password_hash, d.password)))
          throw conflict('Password confirmation failed.');
        return once(ctx, 'approve', d.requestKey, { id }, () =>
          approveRequest(ctx.tx, ctx.branchId!, ctx.session.user.id, id),
        );
      },
    );
  endpoint('post', `${base}/requests/:id/post`, undefined, (ctx) => {
    const d = z.object({ requestKey: uuid }).strict().parse(ctx.req.body),
      id = uuid.parse(ctx.req.params['id']);
    return once(ctx, 'post', d.requestKey, { id }, () =>
      postRequest(ctx.tx, ctx.branchId!, ctx.session.user.id, id),
    );
  });
}
