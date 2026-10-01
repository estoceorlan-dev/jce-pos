import { z } from 'zod';
import {
  uuid,
  version,
  paginationSchema,
  transferInput,
  transferAction,
  transferApproval,
  transferReceiptInput,
  transferDiscrepancyInput,
  transferStatuses,
} from '@jce/shared';
import type { Context, Endpoint } from '../management/router.js';
import type { Json } from '../db/canonical.js';
import { idempotentInTransaction } from '../db/idempotency.js';
import { verifyPassword } from '../auth/service.js';
import { requireFound } from '../management/common.js';
import { installation, conflict } from '../inventory/ledger.js';
import {
  detail,
  productQuery,
  saveTransfer,
  transition,
  receive,
  proposeDiscrepancy,
  resolveDiscrepancy,
} from './service.js';
const base = '/branches/:branchId/transfers';
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
      operation: `transfers.${operation}`,
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
  const user = requireFound(
    (
      await ctx.tx.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id=$1',
        [ctx.session.user.id],
      )
    ).rows[0],
  );
  if (!(await verifyPassword(user.password_hash, password)))
    throw conflict('Password confirmation failed.');
  const start = Date.now(),
    result = await work();
  if (Date.now() - start > 300000)
    throw conflict('Password confirmation expired. Review and try again.');
  return result;
}
export function installTransfers(endpoint: Endpoint) {
  endpoint('get', `${base}/options`, 'transfers.read', async (ctx) => {
    const { q } = z
      .object({ q: z.string().max(100).default('') })
      .strict()
      .parse(ctx.req.query);
    const branches = (
      await ctx.tx.query(
        'SELECT b.id,b.name,b.code FROM branches b JOIN branch_ownership o ON o.branch_id=b.id JOIN installations i ON i.id=o.installation_id WHERE i.singleton AND b.archived_at IS NULL AND b.id<>$1 ORDER BY b.code LIMIT 100',
        [ctx.branchId],
      )
    ).rows;
    const variants = (
      await ctx.tx.query(
        `${productQuery} WHERE NOT v.archived AND NOT p.archived AND NOT u.archived AND (v.sku ILIKE $1 OR p.name ILIKE $1) ORDER BY v.sku LIMIT 100`,
        [`%${q}%`],
      )
    ).rows;
    return { branches, variants, independentInstallations: false };
  });
  endpoint('get', base, 'transfers.read', async (ctx) => {
    const p = paginationSchema
      .extend({
        q: z.string().max(100).default(''),
        status: z.enum(['all', ...transferStatuses]).default('all'),
        direction: z.enum(['all', 'outbound', 'inbound']).default('all'),
      })
      .parse(ctx.req.query);
    const rows = (
      await ctx.tx.query(
        `SELECT t.id,t.number,t.status,t.version,t.created_at,t.source_branch_id,t.destination_branch_id,t.snapshot->'source'->>'name' source,t.snapshot->'destination'->>'name' destination,t.return_of_id FROM stock_transfers t WHERE (t.source_branch_id=$1 OR t.destination_branch_id=$1) AND ($2='all' OR t.status=$2) AND ($3='all' OR ($3='outbound' AND t.source_branch_id=$1) OR ($3='inbound' AND t.destination_branch_id=$1)) AND t.number ILIKE $4 ORDER BY t.created_at DESC,t.id LIMIT $5 OFFSET $6`,
        [
          ctx.branchId,
          p.status,
          p.direction,
          `%${p.q}%`,
          p.limit + 1,
          (p.page - 1) * p.limit,
        ],
      )
    ).rows;
    return { rows: rows.slice(0, p.limit), hasMore: rows.length > p.limit };
  });
  endpoint('get', `${base}/:id`, 'transfers.read', (ctx) =>
    detail(ctx.tx, ctx.branchId!, uuid.parse(ctx.req.params['id'])),
  );
  endpoint('post', base, 'transfers.manage', (ctx) => {
    const d = z
      .object({ requestKey: uuid, transfer: transferInput })
      .strict()
      .parse(ctx.req.body);
    return once(ctx, 'create', d.requestKey, d.transfer, () =>
      saveTransfer(ctx.tx, ctx.branchId!, ctx.session.user.id, d.transfer),
    );
  });
  endpoint('put', `${base}/:id`, 'transfers.manage', (ctx) => {
    const d = z
        .object({ requestKey: uuid, version, transfer: transferInput })
        .strict()
        .parse(ctx.req.body),
      id = uuid.parse(ctx.req.params['id']);
    return once(
      ctx,
      'edit',
      d.requestKey,
      { id, version: d.version, transfer: d.transfer },
      () =>
        saveTransfer(ctx.tx, ctx.branchId!, ctx.session.user.id, d.transfer, {
          id,
          version: d.version,
        }),
    );
  });
  for (const action of [
    'submit',
    'approve',
    'reject',
    'cancel',
    'dispatch',
  ] as const) {
    const permission =
      action === 'approve' || action === 'reject'
        ? 'transfers.approve'
        : action === 'dispatch'
          ? 'transfers.dispatch'
          : 'transfers.manage';
    endpoint('post', `${base}/:id/${action}`, permission, (ctx) => {
      const d = (
          action === 'approve' || action === 'reject'
            ? transferApproval
            : transferAction
        ).parse(ctx.req.body),
        id = uuid.parse(ctx.req.params['id']);
      const work = () =>
        once(
          ctx,
          action,
          d.requestKey,
          { id, version: d.version, note: d.note },
          () =>
            transition(
              ctx.tx,
              ctx.branchId!,
              ctx.session.user.id,
              id,
              d.version,
              action,
              d.note,
            ),
        );
      return 'password' in d
        ? confirmed(ctx, z.string().parse(d.password), work)
        : work();
    });
  }
  endpoint('post', `${base}/:id/receive`, 'transfers.receive', (ctx) => {
    const d = transferReceiptInput.parse(ctx.req.body),
      id = uuid.parse(ctx.req.params['id']);
    return once(ctx, 'receive', d.requestKey, { id, ...d }, () =>
      receive(ctx.tx, ctx.branchId!, ctx.session.user.id, id, d),
    );
  });
  endpoint('post', `${base}/:id/discrepancies`, 'transfers.receive', (ctx) => {
    const d = transferDiscrepancyInput.parse(ctx.req.body),
      id = uuid.parse(ctx.req.params['id']);
    return once(ctx, 'discrepancy_request', d.requestKey, { id, ...d }, () =>
      proposeDiscrepancy(ctx.tx, ctx.branchId!, ctx.session.user.id, id, d),
    );
  });
  endpoint(
    'post',
    `${base}/:id/discrepancies/:requestId/resolve`,
    'transfers.resolve',
    (ctx) => {
      const d = transferApproval.parse(ctx.req.body),
        id = uuid.parse(ctx.req.params['id']),
        requestId = uuid.parse(ctx.req.params['requestId']);
      return confirmed(ctx, d.password, () =>
        once(
          ctx,
          'resolve',
          d.requestKey,
          { id, requestId, version: d.version, note: d.note },
          () =>
            resolveDiscrepancy(
              ctx.tx,
              ctx.branchId!,
              ctx.session.user.id,
              id,
              requestId,
              d.version,
            ),
        ),
      );
    },
  );
}
