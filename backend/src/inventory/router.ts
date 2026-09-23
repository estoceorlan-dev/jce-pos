import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import {
  paginationSchema,
  reservationInput,
  stockDocumentInput,
  stockPostInput,
  uuid,
  version,
} from '@jce/shared';
import type { Endpoint, Context } from '../management/router.js';
import { requireFound } from '../management/common.js';
import { csv } from '../management/catalog.js';
import { verifyPassword } from '../auth/service.js';
import { idempotentInTransaction } from '../db/idempotency.js';
import type { Json } from '../db/canonical.js';
import { decimal } from '../db/decimal.js';
import {
  cancelDocument,
  documentDetail,
  postDocument,
  saveDocument,
} from './documents.js';
import {
  assertReconciled,
  conflict,
  installation,
  inventoryEvent,
  lockInventory,
  reconcile,
} from './ledger.js';

const base = '/branches/:branchId/inventory';
const draftInput = z
  .object({ requestKey: uuid, document: stockDocumentInput })
  .strict();
const editInput = z.object({ version, document: stockDocumentInput }).strict();
const transition = z.object({ requestKey: uuid, version }).strict();
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
      operation: `inventory.${operation}`,
      key,
    },
    { actorId: ctx.session.user.id, branchId: ctx.branchId, data },
    work,
  );
}
export function installInventory(endpoint: Endpoint) {
  endpoint('get', base, 'inventory.read', async ({ tx, branchId, req }) => {
    const query = paginationSchema
      .extend({
        q: z.string().max(100).default(''),
        filter: z
          .enum(['all', 'low', 'out', 'damaged', 'quarantined'])
          .default('all'),
      })
      .parse(req.query);
    const rows = (
      await tx.query(
        `WITH stock AS (
      SELECT v.id variant_id,v.sku,p.name product_name,v.name,u.name unit,v.minimum_stock,
      COALESCE(s.quantity,0)::text on_hand,COALESCE(s.reserved,0)::text reserved,(COALESCE(s.quantity,0)-COALESCE(s.reserved,0))::text available,
      COALESCE(d.quantity,0)::text damaged,COALESCE(q.quantity,0)::text quarantined,
      (COALESCE(s.value,0)+COALESCE(d.value,0)+COALESCE(q.value,0))::text total_value,
      CASE WHEN s.quantity>0 THEN round(s.value/s.quantity,6) ELSE 0 END::text average_cost,
      EXISTS(SELECT 1 FROM stock_counts c JOIN stock_count_items ci ON ci.document_id=c.document_id WHERE c.branch_id=$1 AND ci.variant_id=v.id AND c.released_at IS NULL) frozen
      FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id
      LEFT JOIN inventories s ON s.variant_id=v.id AND s.branch_id=$1 AND s.condition='sellable'
      LEFT JOIN inventories d ON d.variant_id=v.id AND d.branch_id=$1 AND d.condition='damaged'
      LEFT JOIN inventories q ON q.variant_id=v.id AND q.branch_id=$1 AND q.condition='quarantined'
      WHERE (NOT v.archived OR EXISTS(SELECT 1 FROM inventories x WHERE x.variant_id=v.id AND x.branch_id=$1))
      AND (v.sku ILIKE $2 OR p.name ILIKE $2 OR EXISTS(SELECT 1 FROM product_barcodes b WHERE b.variant_id=v.id AND b.barcode ILIKE $2))
    ) SELECT * FROM stock WHERE $3='all' OR ($3='low' AND available::numeric<=minimum_stock) OR ($3='out' AND available::numeric=0)
    OR ($3='damaged' AND damaged::numeric>0) OR ($3='quarantined' AND quarantined::numeric>0)
    ORDER BY sku LIMIT $4 OFFSET $5`,
        [
          branchId,
          `%${query.q}%`,
          query.filter,
          query.limit + 1,
          (query.page - 1) * query.limit,
        ],
      )
    ).rows;
    return {
      rows: rows.slice(0, query.limit),
      hasMore: rows.length > query.limit,
    };
  });
  endpoint(
    'get',
    `${base}/movements/:variantId`,
    'inventory.read',
    async ({ tx, branchId, req }) => {
      const page = paginationSchema.parse(req.query);
      const rows = (
        await tx.query(
          `SELECT m.*,d.number,d.kind FROM inventory_movements m LEFT JOIN stock_adjustments d ON d.id=m.source_id AND d.branch_id=m.branch_id AND m.source_type='stock_adjustment' WHERE m.branch_id=$1 AND m.variant_id=$2 ORDER BY m.occurred_at DESC,m.id DESC LIMIT $3 OFFSET $4`,
          [
            branchId,
            uuid.parse(req.params['variantId']),
            page.limit + 1,
            (page.page - 1) * page.limit,
          ],
        )
      ).rows;
      return {
        rows: rows.slice(0, page.limit),
        hasMore: rows.length > page.limit,
      };
    },
  );
  endpoint(
    'get',
    `${base}/documents`,
    'inventory.read',
    async ({ tx, branchId, req }) => {
      const page = paginationSchema.parse(req.query);
      const rows = (
        await tx.query(
          'SELECT d.id,d.kind,d.status,d.version,d.number,d.note,d.created_at,u.display_name author FROM stock_adjustments d JOIN users u ON u.id=d.actor_id WHERE d.branch_id=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT $2 OFFSET $3',
          [branchId, page.limit + 1, (page.page - 1) * page.limit],
        )
      ).rows;
      return {
        rows: rows.slice(0, page.limit),
        hasMore: rows.length > page.limit,
      };
    },
  );
  endpoint(
    'get',
    `${base}/documents/:id`,
    'inventory.read',
    ({ tx, branchId, req }) =>
      documentDetail(tx, branchId!, uuid.parse(req.params['id'])),
  );
  endpoint(
    'get',
    `${base}/documents/:id/report`,
    'inventory.read',
    async ({ tx, branchId, req }) => {
      const { document: d, items } = await documentDetail(
        tx,
        branchId!,
        uuid.parse(req.params['id']),
      );
      return {
        csv: csv([
          [
            'documentId',
            'number',
            'status',
            'kind',
            'manifestHash',
            'sourceReference',
            'openingDate',
            'sku',
            'condition',
            'beforeQuantity',
            'change',
            'afterQuantity',
            'beforeValue',
            'valueChange',
            'afterValue',
          ],
          ...items.map((i) => [
            d.id,
            d.number,
            d.status,
            d.kind,
            d.content_hash,
            d.manifest.sourceReference,
            d.manifest.openingDate,
            i.snapshot['sku'],
            i.condition,
            i.expected_quantity,
            i.delta,
            i.resulting_quantity,
            i.expected_value,
            i.value_change,
            i.resulting_value,
          ]),
        ]),
      };
    },
  );
  endpoint('post', `${base}/documents`, 'inventory.manage', (ctx) => {
    const data = draftInput.parse(ctx.req.body);
    return once(ctx, 'draft', data.requestKey, data.document, () =>
      saveDocument(ctx.tx, ctx.branchId!, ctx.session.user.id, data.document),
    );
  });
  endpoint('put', `${base}/documents/:id`, 'inventory.manage', (ctx) => {
    const data = editInput.parse(ctx.req.body);
    return saveDocument(
      ctx.tx,
      ctx.branchId!,
      ctx.session.user.id,
      data.document,
      { id: uuid.parse(ctx.req.params['id']), version: data.version },
    );
  });
  endpoint(
    'post',
    `${base}/documents/:id/cancel`,
    'inventory.manage',
    (ctx) => {
      const data = transition.parse(ctx.req.body);
      const id = uuid.parse(ctx.req.params['id']);
      return once(
        ctx,
        'cancel',
        data.requestKey,
        { id, version: data.version },
        () =>
          cancelDocument(
            ctx.tx,
            ctx.branchId!,
            id,
            ctx.session.user.id,
            data.version,
          ),
      );
    },
  );
  endpoint(
    'post',
    `${base}/documents/:id/post`,
    'inventory.approve',
    async (ctx) => {
      const data = stockPostInput.parse(ctx.req.body);
      const id = uuid.parse(ctx.req.params['id']);
      const user = requireFound(
        (
          await ctx.tx.query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE id=$1',
            [ctx.session.user.id],
          )
        ).rows[0],
      );
      if (!(await verifyPassword(user.password_hash, data.password)))
        throw conflict('Password confirmation failed.');
      const confirmedAt = Date.now();
      // Credential is deliberately absent from hashes, persisted responses, audit and outbox.
      return once(
        ctx,
        'post',
        data.requestKey,
        { id, version: data.version },
        async () => {
          const result = await postDocument(
            ctx.tx,
            ctx.branchId!,
            id,
            ctx.session.user.id,
            data.version,
          );
          if (Date.now() - confirmedAt > 5 * 60 * 1000)
            throw conflict(
              'Password confirmation expired. Review and try again.',
            );
          return result;
        },
      );
    },
  );
  endpoint(
    'get',
    `${base}/reconciliation`,
    'inventory.read',
    async ({ tx, branchId }) => {
      const rows = await reconcile(tx, branchId!);
      return { matched: rows.every((r) => r.matched), rows };
    },
  );
  endpoint(
    'get',
    `${base}/reservations`,
    'inventory.read',
    async ({ tx, branchId, req }) => {
      const page = paginationSchema.parse(req.query);
      const rows = (
        await tx.query(
          'SELECT r.*,v.sku FROM inventory_reservations r JOIN product_variants v ON v.id=r.variant_id WHERE r.branch_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT $2 OFFSET $3',
          [branchId, page.limit + 1, (page.page - 1) * page.limit],
        )
      ).rows;
      return {
        rows: rows.slice(0, page.limit),
        hasMore: rows.length > page.limit,
      };
    },
  );
  endpoint('post', `${base}/reservations`, 'inventory.reserve', (ctx) => {
    const data = reservationInput.parse(ctx.req.body);
    return once(ctx, 'reserve', data.requestKey, data, async () => {
      const branchId = ctx.branchId!;
      const tx = ctx.tx;
      await lockInventory(tx, branchId, [data.variantId]);
      const v = requireFound(
        (
          await tx.query<{ fractional: boolean; archived: boolean }>(
            'SELECT v.fractional,(v.archived OR p.archived OR u.archived) archived FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id WHERE v.id=$1',
            [data.variantId],
          )
        ).rows[0],
      );
      if (v.archived || (!v.fractional && !decimal(data.quantity).isInteger()))
        throw conflict('Check product status and whole-unit quantity.');
      const current = await assertReconciled(
        tx,
        branchId,
        data.variantId,
        'sellable',
      );
      if (decimal(current.quantity).minus(current.reserved).lt(data.quantity))
        throw conflict('Insufficient available stock.');
      const id = randomUUID();
      await tx.query(
        'INSERT INTO inventory_reservations(id,installation_id,branch_id,variant_id,quantity,reference,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          await installation(tx, branchId),
          branchId,
          data.variantId,
          data.quantity,
          data.reference,
          ctx.session.user.id,
        ],
      );
      await tx.query(
        "UPDATE inventories SET reserved=reserved+$3,version=version+1 WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
        [branchId, data.variantId, data.quantity],
      );
      await tx.query(
        "INSERT INTO inventory_reservation_events(id,reservation_id,action,actor_id) VALUES($1,$2,'allocated',$3)",
        [randomUUID(), id, ctx.session.user.id],
      );
      await inventoryEvent(tx, {
        branchId,
        actorId: ctx.session.user.id,
        id,
        version: 1,
        action: 'allocated',
      });
      return { id };
    });
  });
  endpoint(
    'post',
    `${base}/reservations/:id/release`,
    'inventory.reserve',
    (ctx) => {
      const { requestKey } = z
        .object({ requestKey: uuid })
        .strict()
        .parse(ctx.req.body);
      const id = uuid.parse(ctx.req.params['id']);
      return once(ctx, 'release', requestKey, { id }, async () => {
        const tx = ctx.tx;
        const branchId = ctx.branchId!;
        const reservation = requireFound(
          (
            await tx.query<{
              variant_id: string;
              quantity: string;
              status: string;
            }>(
              'SELECT * FROM inventory_reservations WHERE id=$1 AND branch_id=$2',
              [id, branchId],
            )
          ).rows[0],
        );
        await lockInventory(tx, branchId, [reservation.variant_id]);
        const current = requireFound(
          (
            await tx.query<{ status: string }>(
              'SELECT status FROM inventory_reservations WHERE id=$1 FOR UPDATE',
              [id],
            )
          ).rows[0],
        );
        if (current.status !== 'active')
          throw conflict('Reservation was already released.');
        await assertReconciled(
          tx,
          branchId,
          reservation.variant_id,
          'sellable',
        );
        await tx.query(
          "UPDATE inventory_reservations SET status='released',released_at=now() WHERE id=$1",
          [id],
        );
        await tx.query(
          "UPDATE inventories SET reserved=reserved-$3,version=version+1 WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
          [branchId, reservation.variant_id, reservation.quantity],
        );
        await tx.query(
          "INSERT INTO inventory_reservation_events(id,reservation_id,action,actor_id) VALUES($1,$2,'released',$3)",
          [randomUUID(), id, ctx.session.user.id],
        );
        await inventoryEvent(tx, {
          branchId,
          actorId: ctx.session.user.id,
          id,
          version: 2,
          action: 'released',
        });
        return { id };
      });
    },
  );
  endpoint('post', `${base}/import`, 'inventory.manage', async (ctx) => {
    const data = z
      .object({
        requestKey: uuid,
        csv: z.string().max(50000),
        sourceReference: z.string().min(1).max(160),
        openingDate: z.iso.date(),
        note: z.string().min(1).max(500),
      })
      .strict()
      .parse(ctx.req.body);
    return once(ctx, 'import', data.requestKey, data, async () => {
      let rows: string[][];
      try {
        rows = parse(data.csv, {
          bom: true,
          skip_empty_lines: true,
          trim: true,
          max_record_size: 2000,
        }) as string[][];
      } catch {
        throw conflict('Invalid CSV. Use the supplied template columns.');
      }
      if (
        rows.shift()?.join(',') !== 'sku,condition,quantity,unitCost' ||
        !rows.length ||
        rows.length > 100
      )
        throw conflict(
          'Use sku,condition,quantity,unitCost with 1 to 100 rows per manifest.',
        );
      const lines = [];
      for (const [index, row] of rows.entries()) {
        const v = (
          await ctx.tx.query<{ id: string }>(
            'SELECT id FROM product_variants WHERE sku=$1',
            [row[0]],
          )
        ).rows[0];
        if (!v || row.length !== 4)
          throw conflict(
            `CSV row ${index + 2}: unknown SKU or incorrect column count.`,
          );
        lines.push({
          variantId: v.id,
          condition: row[1],
          quantity: row[2],
          unitCost: row[3],
        });
      }
      return saveDocument(ctx.tx, ctx.branchId!, ctx.session.user.id, {
        kind: 'opening',
        reasonCode: 'OPENING',
        note: data.note,
        sourceReference: data.sourceReference,
        openingDate: data.openingDate,
        lines,
      });
    });
  });
}
