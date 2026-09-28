import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../backend/src/app.js';
import { createPool } from '../../backend/src/db/pool.js';
import { migrate } from '../../backend/src/db/migrations.js';
import { seedDemo } from '../../backend/src/db/demo.js';
import { withTransaction } from '../../backend/src/db/transaction.js';
import {
  applyMovement,
  installation,
  reconcile,
} from '../../backend/src/inventory/ledger.js';
import { resetTestDatabase, testDatabase } from '../support/database.js';
import { testPassword } from '../support/management.js';
const cfg = testDatabase();
const pool = createPool(cfg.connection('runtime'));
const migration = createPool(cfg.connection('migrator'));
const origin = 'http://127.0.0.1:3100';
const app = createApp({
  ready: async () => true,
  logger: pino({ level: 'silent' }),
  database: { pool, auth: { origin, insecureLoopback: true } },
});
type Auth = { cookie: string; csrf: string; id: string };
let admin: Auth;
let reviewer: Auth;
let staff: Auth;
let cashier: Auth;
let branch: string;
let otherBranch: string;
let base: string;
let supplierId: string;
let unitId: string;
async function login(username: string) {
  const r = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ username, password: testPassword });
  expect(r.status, r.text).toBe(200);
  return {
    cookie: (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
    csrf: r.body.csrfToken as string,
    id: r.body.user.id as string,
  };
}
const get = (path: string, auth = admin) =>
  request(app)
    .get('/api/v1' + path)
    .set('Cookie', auth.cookie);
function send(
  path: string,
  data: object,
  auth = admin,
  method: 'post' | 'put' = 'post',
) {
  const agent = request(app);
  return agent[method]('/api/v1' + path)
    .set('Cookie', auth.cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', auth.csrf)
    .send(data);
}
async function user(name: string, role: string) {
  const r = await send('/users', {
    username: name,
    displayName: name,
    password: testPassword,
    roles: [role],
    branchIds: [branch],
  });
  expect(r.status, r.text).toBe(200);
  await migration.query(
    'UPDATE users SET must_change_password=false WHERE id=$1',
    [r.body.id],
  );
  return login(name);
}
async function variant(conversion = '1') {
  const sku = `PO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const r = await send('/catalog/variants', {
    productName: 'Purchase fixture',
    name: 'Standard',
    sku,
    unitId,
    conversion,
    fractional: false,
    minimumStock: '0',
    taxCodeId: null,
    categoryId: null,
    brandId: null,
    barcodes: [],
    archived: false,
  });
  expect(r.status, r.text).toBe(200);
  return r.body.id as string;
}
const line = (variantId: string, quantity = '5', extra = {}) => ({
  variantId,
  quantity,
  unitCost: '10',
  discountRate: '0',
  taxRate: '0',
  taxInclusive: false,
  capitalizeTax: false,
  ...extra,
});
async function order(variantId: string, quantity = '5', extra = {}) {
  const r = await send(`${base}/orders`, {
    requestKey: randomUUID(),
    order: {
      supplierId,
      note: 'Synthetic purchase',
      lines: [line(variantId, quantity, extra)],
    },
  });
  expect(r.status, r.text).toBe(200);
  return r.body as { id: string; version: number };
}
async function transition(
  id: string,
  version: number,
  action: string,
  auth = admin,
) {
  return send(
    `${base}/orders/${id}/${action}`,
    {
      requestKey: randomUUID(),
      version,
      reason: 'Synthetic review',
      ...(['approve', 'reject', 'close'].includes(action)
        ? { password: testPassword }
        : {}),
    },
    auth,
  );
}
async function approved(variantId: string, quantity = '5', extra = {}) {
  const d = await order(variantId, quantity, extra);
  expect((await transition(d.id, 1, 'submit')).status).toBe(200);
  const r = await transition(d.id, 2, 'approve', reviewer);
  expect(r.status, r.text).toBe(200);
  return (await get(`${base}/orders/${d.id}`)).body as {
    order: { id: string; version: number };
    lines: { id: string }[];
  };
}
async function receipt(
  orderId: string,
  orderItemId: string,
  quantity: string,
  deliveryReference = randomUUID(),
) {
  const data = {
    orderId,
    supplierReference: 'SYNTHETIC-INVOICE',
    deliveryReference,
    note: 'Test receiving',
    lines: [{ orderItemId, quantity, condition: 'sellable' }],
  };
  const r = await send(`${base}/receipts`, {
    requestKey: randomUUID(),
    receipt: data,
  });
  expect(r.status, r.text).toBe(200);
  return { ...(r.body as { id: string; version: number }), data };
}
const post = (id: string, version = 1, requestKey = randomUUID()) =>
  send(`${base}/receipts/${id}/post`, { version, requestKey });
async function reverse(id: string) {
  const r = await send(`${base}/reversals`, {
    requestKey: randomUUID(),
    originalId: id,
    reason: 'Synthetic full correction',
  });
  expect(r.status, r.text).toBe(200);
  return r.body as { id: string; version: number };
}
const approveReversal = (
  id: string,
  auth = reviewer,
  requestKey = randomUUID(),
) =>
  send(
    `${base}/receipts/${id}/approve-reversal`,
    { version: 1, requestKey, password: testPassword },
    auth,
  );
beforeAll(async () => {
  await resetTestDatabase();
  await migrate(migration, { targetVersion: 5 });
  const data = await seedDemo(migration, {
    username: 'test.admin',
    displayName: 'Synthetic administrator',
    password: testPassword,
  });
  [branch, otherBranch] = data.branches as [string, string];
  const prior = (
    await migration.query('SELECT id FROM product_variants LIMIT 1')
  ).rows[0].id as string;
  await migration.query(
    "INSERT INTO inventories(branch_id,variant_id,condition,quantity,value) VALUES($1,$2,'sellable',2,20)",
    [branch, prior],
  );
  const install = (await migration.query('SELECT id FROM installations'))
    .rows[0].id;
  await migration.query(
    "INSERT INTO inventory_movements(id,installation_id,branch_id,variant_id,condition,quantity,value,source_type,source_id,source_line_id,actor_id) VALUES($1,$2,$3,$4,'sellable',2,20,'upgrade_fixture',$5,$6,$7)",
    [
      randomUUID(),
      install,
      branch,
      prior,
      randomUUID(),
      randomUUID(),
      data.userId,
    ],
  );
  await migrate(migration);
  expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
  expect(
    (await pool.query('SELECT count(*) FROM purchases')).rows[0].count,
  ).toBe('0');
  base = `/branches/${branch}/purchasing`;
  admin = await login('test.admin');
  reviewer = await user('purchase.reviewer', 'manager');
  staff = await user('purchase.staff', 'inventory');
  cashier = await user('purchase.cashier', 'cashier');
  unitId = (await get('/catalog/lookups')).body.units[0].id;
  const supplier = await send(`/branches/${branch}/suppliers`, {
    name: 'Synthetic supplier',
    contact: '',
    archived: false,
  });
  expect(supplier.status, supplier.text).toBe(200);
  supplierId = supplier.body.id;
}, 30000);
beforeEach(async () => {
  await migration.query('DELETE FROM login_throttles');
});
afterAll(async () => {
  await Promise.all([pool.end(), migration.end()]);
});
describe('purchasing and receiving', () => {
  it('posts partial pack deliveries with exact costs, supplier totals and idempotency', async () => {
    const v = await variant('6');
    const po = await approved(v, '5', {
      unitCost: '120',
      discountRate: '0.1',
      taxRate: '0.12',
    });
    expect(
      (
        await pool.query(
          'SELECT 1 FROM inventory_movements WHERE variant_id=$1',
          [v],
        )
      ).rowCount,
    ).toBe(0);
    const first = await receipt(po.order.id, po.lines[0]!.id, '2');
    const key = randomUUID();
    const results = await Promise.all([
      post(first.id, 1, key),
      post(first.id, 1, key),
    ]);
    for (const r of results) expect(r.status, r.text).toBe(200);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect((await get(`${base}/orders/${po.order.id}`)).body.order.status).toBe(
      'partially_received',
    );
    expect(
      (await get(`${base}/receipts/${first.id}`)).body.receipt,
    ).toMatchObject({
      net: '216.00',
      tax: '25.92',
      total: '241.92',
      stock_value: '216.000000',
    });
    const last = await receipt(po.order.id, po.lines[0]!.id, '3');
    expect((await post(last.id)).status).toBe(200);
    const completed = await get(`${base}/orders/${po.order.id}`);
    expect(completed.body.order.status).toBe('received');
    expect(completed.body.lines[0].received).toBe('5.000000');
    const stock = (
      await pool.query(
        "SELECT quantity,value FROM inventories WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
        [branch, v],
      )
    ).rows[0];
    expect(stock).toEqual({ quantity: '30.000000', value: '540.000000' });
    expect(
      (await get(`${base}/receipts?orderId=${po.order.id}`)).body.totals,
    ).toMatchObject({ total: '604.80', stock_value: '540.000000' });
    expect((await post(first.id, 2, key)).status).toBe(409);
    expect(
      (await get(`/branches/${branch}/inventory/movements/${v}`)).body.rows[0]
        .number,
    ).toMatch(/^GR-/);
  });
  it('requires approval and enforces actor, branch, object, CSRF and permission boundaries', async () => {
    const v = await variant();
    const d = await order(v);
    expect((await transition(d.id, 1, 'approve', reviewer)).status).toBe(409);
    const item = (await get(`${base}/orders/${d.id}`)).body.lines[0].id;
    expect(
      (
        await send(`${base}/receipts`, {
          requestKey: randomUUID(),
          receipt: {
            orderId: d.id,
            supplierReference: 'x',
            deliveryReference: 'x',
            note: '',
            lines: [
              { orderItemId: item, quantity: '1', condition: 'sellable' },
            ],
          },
        })
      ).status,
    ).toBe(409);
    expect((await transition(d.id, 1, 'submit')).status).toBe(200);
    expect((await transition(d.id, 2, 'approve')).status).toBe(403);
    expect((await transition(d.id, 2, 'approve', staff)).status).toBe(403);
    expect(
      (
        await send(
          `${base}/orders/${d.id}/approve`,
          {
            version: 2,
            requestKey: randomUUID(),
            reason: 'test',
            password: 'wrong',
          },
          reviewer,
        )
      ).status,
    ).toBe(409);
    expect(
      (await get(`/branches/${otherBranch}/purchasing/orders`, staff)).status,
    ).toBe(403);
    expect(
      (await get(`/branches/${otherBranch}/purchasing/orders/${d.id}`)).status,
    ).toBe(404);
    expect((await get(`${base}/orders`, cashier)).status).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/v1${base}/orders/${d.id}/cancel`)
          .set('Cookie', admin.cookie)
          .set('Origin', origin)
          .send({})
      ).status,
    ).toBe(403);
    expect((await transition(d.id, 2, 'approve', reviewer)).status).toBe(200);
  });
  it('rejects excess and prevents simultaneous deliveries from exceeding approval', async () => {
    const po = await approved(await variant());
    const item = po.lines[0]!.id;
    expect(
      (
        await send(`${base}/receipts`, {
          requestKey: randomUUID(),
          receipt: {
            orderId: po.order.id,
            supplierReference: 'x',
            deliveryReference: 'x',
            note: '',
            lines: [
              { orderItemId: item, quantity: '6', condition: 'sellable' },
            ],
          },
        })
      ).status,
    ).toBe(409);
    const a = await receipt(po.order.id, item, '3');
    const b = await receipt(po.order.id, item, '3');
    const results = await Promise.all([post(a.id), post(b.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await get(`${base}/orders/${po.order.id}`)).body.lines[0].received,
    ).toBe('3.000000');
    const winner = results[0]!.status === 200 ? a : b;
    const dup = await receipt(
      po.order.id,
      item,
      '1',
      winner.data.deliveryReference,
    );
    expect((await post(dup.id)).status).toBe(409);
    expect(
      (await get(`${base}/orders/${po.order.id}`)).body.lines[0].received,
    ).toBe('3.000000');
  });
  it('supports stale-safe drafts, rejection/cancellation and reviewed remainder closure', async () => {
    const v = await variant();
    const d = await order(v);
    const data = {
      version: 1,
      order: { supplierId, note: 'Edited', lines: [line(v)] },
    };
    expect(
      (await send(`${base}/orders/${d.id}`, data, admin, 'put')).status,
    ).toBe(200);
    expect(
      (await send(`${base}/orders/${d.id}`, data, admin, 'put')).status,
    ).toBe(409);
    expect((await transition(d.id, 2, 'submit')).status).toBe(200);
    expect((await transition(d.id, 3, 'reject', reviewer)).status).toBe(200);
    expect((await transition(d.id, 4, 'approve', reviewer)).status).toBe(409);
    const cancel = await order(v);
    expect((await transition(cancel.id, 1, 'cancel')).status).toBe(200);
    const po = await approved(v);
    await expect(
      pool.query("UPDATE purchase_orders SET status='draft' WHERE id=$1", [
        po.order.id,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        'UPDATE purchase_order_items SET unit_cost=1 WHERE order_id=$1',
        [po.order.id],
      ),
    ).rejects.toThrow();
    const r = await receipt(po.order.id, po.lines[0]!.id, '2');
    expect((await post(r.id)).status).toBe(200);
    const pending = await receipt(po.order.id, po.lines[0]!.id, '1');
    expect((await transition(po.order.id, 4, 'close', reviewer)).status).toBe(
      200,
    );
    expect((await post(pending.id)).status).toBe(409);
    expect(
      (
        await send(`${base}/receipts/${pending.id}/cancel`, {
          version: 1,
          requestKey: randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (await get(`${base}/orders/${po.order.id}`)).body.lines[0].outstanding,
    ).toBe('3.000000');
    expect(
      (await get(`${base}/orders?status=outstanding`)).body.rows.some(
        (r: { id: string }) => r.id === po.order.id,
      ),
    ).toBe(false);
    const rev = await reverse(r.id);
    expect((await approveReversal(rev.id)).status).toBe(200);
    expect((await get(`${base}/orders/${po.order.id}`)).body.order.status).toBe(
      'closed',
    );
  });
  it('reverses exact source value once without rewriting receipt history', async () => {
    const v = await variant();
    const po = await approved(v, '3', { unitCost: '0.333333' });
    const r = await receipt(po.order.id, po.lines[0]!.id, '3');
    expect((await post(r.id)).status).toBe(200);
    await expect(
      pool.query("UPDATE purchases SET note='rewrite' WHERE id=$1", [r.id]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM purchase_items WHERE purchase_id=$1', [r.id]),
    ).rejects.toThrow();
    const rev = await reverse(r.id);
    expect((await approveReversal(rev.id, admin)).status).toBe(403);
    const key = randomUUID();
    expect((await approveReversal(rev.id, reviewer, key)).status).toBe(200);
    expect((await approveReversal(rev.id, reviewer, key)).status).toBe(200);
    expect((await get(`${base}/receipts/${r.id}`)).body.receipt.status).toBe(
      'posted',
    );
    expect(
      (await get(`${base}/receipts/${rev.id}`)).body.receipt,
    ).toMatchObject({ stock_value: '-0.999999', total: '-1.00' });
    expect((await get(`${base}/orders/${po.order.id}`)).body.order.status).toBe(
      'approved',
    );
    expect(
      (await get(`${base}/receipts?orderId=${po.order.id}`)).body.totals.total,
    ).toBe('0.00');
    expect(
      (
        await pool.query(
          "SELECT quantity,value FROM inventories WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
          [branch, v],
        )
      ).rows[0],
    ).toEqual({ quantity: '0.000000', value: '0.000000' });
    expect(
      (
        await send(`${base}/reversals`, {
          requestKey: randomUUID(),
          originalId: r.id,
          reason: 'duplicate',
        })
      ).status,
    ).toBe(409);
  });
  it('blocks reversals after stock consumption and protects reserved quantities', async () => {
    const v = await variant();
    const po = await approved(v);
    const r = await receipt(po.order.id, po.lines[0]!.id, '5');
    expect((await post(r.id)).status).toBe(200);
    const rev = await reverse(r.id);
    const reserved = await send(`/branches/${branch}/inventory/reservations`, {
      requestKey: randomUUID(),
      variantId: v,
      quantity: '1',
      reference: 'protect test',
    });
    expect(reserved.status).toBe(200);
    expect((await approveReversal(rev.id)).status).toBe(409);
    expect(
      (
        await send(
          `/branches/${branch}/inventory/reservations/${reserved.body.id}/release`,
          { requestKey: randomUUID() },
        )
      ).status,
    ).toBe(200);
    await withTransaction(pool, async (tx) => {
      await applyMovement(tx, {
        installationId: await installation(tx, branch),
        branchId: branch,
        variantId: v,
        condition: 'sellable',
        quantity: '-1',
        unitCost: '0',
        sourceType: 'test_sale',
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
        actorId: admin.id,
      });
      await applyMovement(tx, {
        installationId: await installation(tx, branch),
        branchId: branch,
        variantId: v,
        condition: 'sellable',
        quantity: '1',
        unitCost: '10',
        sourceType: 'test_restock',
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
        actorId: admin.id,
      });
    });
    const failure = await approveReversal(rev.id);
    expect(failure.status).toBe(409);
    expect(failure.body.error.message).toContain('Stock has moved');
  });
  it('refreshes changed cumulative rounding allocations before posting', async () => {
    const po = await approved(await variant(), '3', { unitCost: '0.333333' });
    const a = await receipt(po.order.id, po.lines[0]!.id, '1');
    const b = await receipt(po.order.id, po.lines[0]!.id, '1');
    b.data.lines[0]!.condition = 'damaged';
    expect((await post(a.id)).status).toBe(200);
    expect((await post(b.id)).status).toBe(409);
    expect(
      (
        await send(
          `${base}/receipts/${b.id}`,
          { version: 1, receipt: b.data },
          admin,
          'put',
        )
      ).status,
    ).toBe(200);
    expect((await post(b.id, 2)).status).toBe(200);
    expect((await get(`${base}/receipts/${b.id}`)).body.receipt.total).toBe(
      '0.34',
    );
    const earlyReversal = await reverse(a.id);
    const blocked = await approveReversal(earlyReversal.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Later receiving remains');
    const laterReversal = await reverse(b.id);
    expect((await approveReversal(laterReversal.id)).status).toBe(200);
    expect((await approveReversal(earlyReversal.id)).status).toBe(200);
  });
  it('rolls back a late posting failure with no stock, order or history duplication', async () => {
    const variantId = await variant();
    const po = await approved(variantId);
    const r = await receipt(po.order.id, po.lines[0]!.id, '2');
    const count = await send(`/branches/${branch}/inventory/documents`, {
      requestKey: randomUUID(),
      document: {
        kind: 'count',
        reasonCode: 'COUNT_VARIANCE',
        note: 'Scoped freeze test',
        lines: [
          { variantId, condition: 'sellable', quantity: '0', unitCost: '0' },
        ],
      },
    });
    expect(count.status, count.text).toBe(200);
    expect((await post(r.id)).status).toBe(409);
    expect(
      (
        await send(
          `/branches/${branch}/inventory/documents/${count.body.id}/cancel`,
          { version: 1, requestKey: randomUUID() },
        )
      ).status,
    ).toBe(200);
    await migration.query(
      "CREATE FUNCTION public.fail_purchase_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='purchasing.changed' AND NEW.payload->>'action'='posted' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$",
    );
    await migration.query(
      'CREATE TRIGGER fail_purchase BEFORE INSERT ON sync_queue FOR EACH ROW EXECUTE FUNCTION public.fail_purchase_event()',
    );
    const key = randomUUID();
    try {
      expect((await post(r.id, 1, key)).status).toBe(500);
    } finally {
      await migration.query('DROP TRIGGER fail_purchase ON sync_queue');
      await migration.query('DROP FUNCTION public.fail_purchase_event()');
    }
    expect((await get(`${base}/receipts/${r.id}`)).body.receipt.status).toBe(
      'draft',
    );
    expect((await get(`${base}/orders/${po.order.id}`)).body.order.status).toBe(
      'approved',
    );
    for (const [table, column] of [
      ['inventory_movements', 'source_id'],
      ['document_numbers', 'document_id'],
      ['audit_logs', 'entity_id'],
    ] as const) {
      const rows = await pool.query(
        `SELECT 1 FROM ${table} WHERE ${column}=$1${table === 'audit_logs' ? " AND action='purchasing.posted'" : ''}`,
        [r.id],
      );
      expect(rows.rowCount).toBe(0);
    }
    expect(
      (
        await pool.query(
          'SELECT 1 FROM idempotency_requests WHERE request_key=$1',
          [key],
        )
      ).rowCount,
    ).toBe(0);
    expect((await post(r.id, 1, key)).status).toBe(200);
    expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
  });
});
