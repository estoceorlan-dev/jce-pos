import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import type { StockDocumentInput } from '@jce/shared';
import { createApp } from '../../backend/src/app.js';
import { createPool } from '../../backend/src/db/pool.js';
import { withTransaction } from '../../backend/src/db/transaction.js';
import {
  applyMovement,
  installation,
  lockInventory,
  reconcile,
} from '../../backend/src/inventory/ledger.js';
import { testDatabase } from '../support/database.js';
import { setupManagement, testPassword } from '../support/management.js';
const config = testDatabase();
const pool = createPool(config.connection('runtime'));
const migration = createPool(config.connection('migrator'));
const origin = 'http://127.0.0.1:3100';
const app = createApp({
  ready: async () => true,
  logger: pino({ level: 'silent' }),
  database: { pool, auth: { origin, insecureLoopback: true } },
});
type Login = { cookie: string; csrf: string; id: string };
let admin: Login;
let reviewer: Login;
let staff: Login;
let cashier: Login;
let branchA: string;
let branchB: string;
let unitId: string;
let base: string;
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
const send = (
  path: string,
  data: object,
  auth = admin,
  method: 'post' | 'put' = 'post',
) => {
  const agent = request(app);
  return agent[method]('/api/v1' + path)
    .set('Cookie', auth.cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', auth.csrf)
    .send(data);
};
async function user(name: string, role: string) {
  const r = await send('/users', {
    username: name,
    displayName: name,
    password: testPassword,
    roles: [role],
    branchIds: [branchA],
  });
  expect(r.status, r.text).toBe(200);
  await migration.query(
    'UPDATE users SET must_change_password=false WHERE id=$1',
    [r.body.id],
  );
  return login(name);
}
async function variant(sku: string, fractional = false) {
  if (fractional)
    await migration.query(
      'UPDATE product_units SET fractional=true WHERE id=$1',
      [unitId],
    );
  const r = await send('/catalog/variants', {
    productName: sku,
    name: 'Standard',
    sku,
    unitId,
    conversion: '1',
    fractional,
    minimumStock: '2',
    taxCodeId: null,
    categoryId: null,
    brandId: null,
    barcodes: [],
    archived: false,
  });
  expect(r.status, r.text).toBe(200);
  return r.body.id as string;
}
const doc = (
  variantId: string,
  quantity = '10',
  extra: Partial<StockDocumentInput> = {},
): StockDocumentInput => ({
  kind: 'adjustment',
  reasonCode: 'FOUND',
  note: 'Synthetic stock test',
  sourceReference: 'test-manifest',
  sourceDocumentId: null,
  openingDate: null,
  lines: [{ variantId, condition: 'sellable', quantity, unitCost: '10' }],
  ...extra,
});
async function draft(document: StockDocumentInput, auth = admin) {
  const r = await send(
    `${base}/documents`,
    { requestKey: randomUUID(), document },
    auth,
  );
  expect(r.status, r.text).toBe(200);
  return r.body as { id: string; version: number };
}
async function post(
  d: { id: string; version: number },
  auth = reviewer,
  key = randomUUID(),
) {
  return send(
    `${base}/documents/${d.id}/post`,
    { version: d.version, requestKey: key, password: testPassword },
    auth,
  );
}
async function seed(
  variantId: string,
  quantity = '10',
  extra: Partial<StockDocumentInput> = {},
) {
  const d = await draft(doc(variantId, quantity, extra));
  const r = await post(d);
  expect(r.status, r.text).toBe(200);
  return d;
}
beforeAll(async () => {
  const data = await setupManagement();
  [branchA, branchB] = data.branches as [string, string];
  base = `/branches/${branchA}/inventory`;
  admin = await login('test.admin');
  reviewer = await user('stock.reviewer', 'manager');
  staff = await user('stock.staff', 'inventory');
  cashier = await user('stock.cashier', 'cashier');
  unitId = (await get('/catalog/lookups')).body.units[0].id;
}, 30000);
afterAll(async () => {
  await Promise.all([pool.end(), migration.end()]);
});
beforeEach(async () => {
  await migration.query('DELETE FROM login_throttles');
});
describe('inventory posting, approval and ledger', () => {
  it('stages a dated valued import, requires a different reviewer, and replays once', async () => {
    const id = await variant('OPENING');
    const input = {
      requestKey: randomUUID(),
      csv: 'sku,condition,quantity,unitCost\nOPENING,sellable,10,12.50\nOPENING,damaged,2,8\nOPENING,quarantined,1,8',
      sourceReference: 'synthetic.csv',
      openingDate: '2026-09-01',
      note: 'Synthetic opening import',
    };
    const r = await send(`${base}/import`, input);
    expect(r.status, r.text).toBe(200);
    const d = r.body as { id: string; version: number };
    expect((await send(`${base}/import`, input)).body).toEqual(d);
    expect(
      (await pool.query('SELECT count(*) FROM inventory_movements')).rows[0]
        .count,
    ).toBe('0');
    expect((await post(d, admin)).status).toBe(403);
    expect((await post(d, staff)).status).toBe(403);
    const key = randomUUID();
    const [posted, duplicate] = await Promise.all([
      post(d, reviewer, key),
      post(d, reviewer, key),
    ]);
    expect(posted.status, posted.text).toBe(200);
    expect(duplicate.status, duplicate.text).toBe(200);
    expect(duplicate.body).toEqual(posted.body);
    expect((await post(d, reviewer, key)).body).toEqual(posted.body);
    expect((await post({ ...d, version: 2 }, reviewer, key)).status).toBe(409);
    const row = (await get(`${base}?q=OPENING`)).body.rows[0];
    expect(row).toMatchObject({
      on_hand: '10.000000',
      available: '10.000000',
      damaged: '2.000000',
      quarantined: '1.000000',
      total_value: '149.000000',
    });
    const detail = await get(`${base}/documents/${d.id}`);
    expect(detail.body.totalValueChange).toBe('149.000000');
    expect(detail.body.document.content_hash).toHaveLength(64);
    expect((await get(`${base}/movements/${id}`)).body.rows).toHaveLength(3);
    expect(
      (
        await send(`${base}/documents`, {
          requestKey: randomUUID(),
          document: doc(id, '1', {
            kind: 'opening',
            reasonCode: 'OPENING',
            openingDate: '2026-09-01',
          }),
        })
      ).status,
    ).toBe(409);
    const audit = await pool.query(
      "SELECT 1 FROM audit_logs WHERE entity_id=$1 AND action='inventory.posted'",
      [d.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM sync_queue WHERE aggregate_id=$1 AND payload->>'action'='posted'",
          [d.id],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      pool.query('UPDATE inventory_movements SET quantity=0'),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM inventory_movements'),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE stock_adjustments SET note='rewrite' WHERE id=$1", [
        d.id,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        'UPDATE stock_adjustment_items SET quantity=1 WHERE document_id=$1',
        [d.id],
      ),
    ).rejects.toThrow();
    const other = await draft(doc(id, '1'));
    await expect(
      pool.query(
        'UPDATE stock_adjustment_items SET document_id=$2 WHERE document_id=$1',
        [d.id, other.id],
      ),
    ).rejects.toThrow();
  });
  it('enforces branch, CSRF, object scope and permission checks', async () => {
    expect((await get(`/branches/${branchB}/inventory`, staff)).status).toBe(
      403,
    );
    expect((await get(base, cashier)).status).toBe(403);
    const id = await variant('SCOPED');
    const d = await draft(doc(id));
    expect(
      (await get(`/branches/${branchB}/inventory/documents/${d.id}`)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/v1${base}/documents`)
          .set('Origin', origin)
          .set('Cookie', admin.cookie)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          `${base}/documents/${d.id}/post`,
          { version: 1, requestKey: randomUUID(), password: 'incorrect' },
          reviewer,
        )
      ).status,
    ).toBe(409);
    expect((await get(`${base}/documents/${d.id}`)).body.document.status).toBe(
      'draft',
    );
  });
  it('computes weighted costs, preserves fractional residue and excludes reservations', async () => {
    const id = await variant('WEIGHTED', true);
    await seed(id, '2');
    await seed(id, '3', {
      lines: [
        { variantId: id, condition: 'sellable', quantity: '3', unitCost: '20' },
      ],
    });
    let row = (await get(`${base}?q=WEIGHTED`)).body.rows[0];
    expect(row.average_cost).toBe('16.000000');
    const input = {
      requestKey: randomUUID(),
      variantId: id,
      quantity: '4',
      reference: 'Synthetic reservation',
    };
    const r = await send(`${base}/reservations`, input, staff);
    expect(r.status, r.text).toBe(200);
    expect((await send(`${base}/reservations`, input, staff)).body).toEqual(
      r.body,
    );
    expect(
      (
        await send(`${base}/documents`, {
          requestKey: randomUUID(),
          document: doc(id, '-2'),
        })
      ).status,
    ).toBe(409);
    await seed(id, '-1');
    row = (await get(`${base}?q=WEIGHTED`)).body.rows[0];
    expect(row).toMatchObject({
      on_hand: '4.000000',
      available: '0.000000',
      total_value: '64.000000',
    });
    const release = { requestKey: randomUUID() };
    expect(
      (await send(`${base}/reservations/${r.body.id}/release`, release, staff))
        .status,
    ).toBe(200);
    expect(
      (await send(`${base}/reservations/${r.body.id}/release`, release, staff))
        .status,
    ).toBe(200);
    await seed(id, '-4');
    expect((await get(`${base}?q=WEIGHTED`)).body.rows[0].total_value).toBe(
      '0.000000',
    );
    expect((await get(`${base}?q=WEIGHTED&filter=out`)).body.rows).toHaveLength(
      1,
    );
    await expect(
      pool.query(
        "UPDATE inventory_reservations SET status='active',released_at=NULL WHERE id=$1",
        [r.body.id],
      ),
    ).rejects.toThrow();
  });
  it('freezes a count scope, supports counted edits and releases on post or cancellation', async () => {
    const id = await variant('COUNTED');
    await seed(id);
    const d = await draft(
      doc(id, '10', { kind: 'count', reasonCode: 'COUNT_VARIANCE' }),
      staff,
    );
    expect((await get(`${base}?q=COUNTED`)).body.rows[0].frozen).toBe(true);
    expect(
      (
        await send(
          `${base}/reservations`,
          {
            requestKey: randomUUID(),
            variantId: id,
            quantity: '1',
            reference: 'blocked',
          },
          staff,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await send(`${base}/documents`, {
          requestKey: randomUUID(),
          document: doc(id, '1'),
        })
      ).status,
    ).toBe(409);
    const edited = await send(
      `${base}/documents/${d.id}`,
      {
        version: 1,
        document: doc(id, '7', { kind: 'count', reasonCode: 'COUNT_VARIANCE' }),
      },
      staff,
      'put',
    );
    expect(edited.status, edited.text).toBe(200);
    expect((await post(d)).status).toBe(409);
    expect((await post({ id: d.id, version: 2 })).status).toBe(200);
    expect((await get(`${base}?q=COUNTED`)).body.rows[0]).toMatchObject({
      on_hand: '7.000000',
      total_value: '70.000000',
      frozen: false,
    });
    const cancelled = await draft(
      doc(id, '7', { kind: 'count', reasonCode: 'COUNT_VARIANCE' }),
    );
    expect(
      (
        await send(`${base}/documents/${cancelled.id}/cancel`, {
          version: 1,
          requestKey: randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect((await get(`${base}?q=COUNTED`)).body.rows[0].frozen).toBe(false);
  });
  it('rejects stale balances, stale draft edits and invalid imports atomically', async () => {
    const id = await variant('STALE');
    await seed(id);
    const d = await draft(doc(id, '-1'));
    await seed(id, '1');
    expect((await post(d)).status).toBe(409);
    const input = { version: 1, document: doc(id, '-1') };
    expect(
      (await send(`${base}/documents/${d.id}`, input, admin, 'put')).status,
    ).toBe(200);
    expect(
      (await send(`${base}/documents/${d.id}`, input, admin, 'put')).status,
    ).toBe(409);
    expect((await post({ id: d.id, version: 2 })).status).toBe(200);
    const before = (await pool.query('SELECT count(*) FROM stock_adjustments'))
      .rows[0].count;
    const bad = await send(`${base}/import`, {
      requestKey: randomUUID(),
      csv: 'sku,condition,quantity,unitCost\nMISSING,sellable,2,10',
      sourceReference: 'bad',
      openingDate: '2026-09-01',
      note: 'bad',
    });
    expect(bad.status).toBe(409);
    expect(
      (await pool.query('SELECT count(*) FROM stock_adjustments')).rows[0]
        .count,
    ).toBe(before);
  });
  it('rolls back stock, documents, audit, outbox and idempotency after a late failure', async () => {
    const id = await variant('ROLLBACK');
    const d = await draft(doc(id));
    await migration.query(
      `CREATE FUNCTION public.fail_inventory_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='inventory.changed' AND NEW.payload->>'action'='posted' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$`,
    );
    await migration.query(
      'CREATE TRIGGER injected_inventory_failure BEFORE INSERT ON sync_queue FOR EACH ROW EXECUTE FUNCTION public.fail_inventory_event()',
    );
    const key = randomUUID();
    try {
      expect((await post(d, reviewer, key)).status).toBe(500);
    } finally {
      await migration.query(
        'DROP TRIGGER injected_inventory_failure ON sync_queue',
      );
      await migration.query('DROP FUNCTION public.fail_inventory_event()');
    }
    expect((await get(`${base}/documents/${d.id}`)).body.document.status).toBe(
      'draft',
    );
    expect(
      (
        await pool.query(
          'SELECT 1 FROM inventory_movements WHERE source_id=$1',
          [d.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM idempotency_requests WHERE request_key=$1',
          [key],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE entity_id=$1 AND action='inventory.posted'",
          [d.id],
        )
      ).rowCount,
    ).toBe(0);
    expect((await post(d, reviewer, key)).status).toBe(200);
  });
  it('prevents competing last-unit deductions using real independent PostgreSQL transactions', async () => {
    const id = await variant('LAST-UNIT');
    await seed(id, '1');
    const deduct = () =>
      withTransaction(pool, async (tx) => {
        await lockInventory(tx, branchA, [id]);
        await applyMovement(tx, {
          installationId: await installation(tx, branchA),
          branchId: branchA,
          variantId: id,
          condition: 'sellable',
          quantity: '-1',
          unitCost: '0',
          sourceType: 'test_deduction',
          sourceId: randomUUID(),
          sourceLineId: randomUUID(),
          actorId: admin.id,
        });
      });
    const results = await Promise.allSettled([deduct(), deduct()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await get(`${base}?q=LAST-UNIT`)).body.rows[0].on_hand).toBe(
      '0.000000',
    );
    expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
  });
  it('detects drift without writing, blocks ordinary movements, and requires reviewed repair', async () => {
    const id = await variant('REPAIR');
    await seed(id, '5');
    await migration.query(
      "UPDATE inventories SET quantity=4,value=40 WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
      [branchA, id],
    );
    const before = await pool.query('SELECT count(*) FROM inventory_movements');
    const report = await get(`${base}/reconciliation`);
    expect(report.body.matched).toBe(false);
    expect(
      (await pool.query('SELECT count(*) FROM inventory_movements')).rows,
    ).toEqual(before.rows);
    expect(
      (
        await send(`${base}/documents`, {
          requestKey: randomUUID(),
          document: doc(id, '1'),
        })
      ).status,
    ).toBe(409);
    const d = await draft(
      doc(id, '0', { kind: 'reconcile', reasonCode: 'RECONCILIATION' }),
    );
    expect((await post(d)).status).toBe(200);
    expect((await get(`${base}?q=REPAIR`)).body.rows[0]).toMatchObject({
      on_hand: '5.000000',
      total_value: '50.000000',
    });
    expect((await get(`${base}/reconciliation`)).body.matched).toBe(true);
    expect(
      (await pool.query('SELECT count(*) FROM inventory_movements')).rows,
    ).toEqual(before.rows);
  });
});
