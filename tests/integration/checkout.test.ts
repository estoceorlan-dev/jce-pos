import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../backend/src/app.js';
import { createPool } from '../../backend/src/db/pool.js';
import { migrate } from '../../backend/src/db/migrations.js';
import { seedDemo } from '../../backend/src/db/demo.js';
import { withTransaction } from '../../backend/src/db/transaction.js';
import { authLock } from '../../backend/src/auth/service.js';
import {
  applyMovement,
  installation,
  reconcile,
} from '../../backend/src/inventory/ledger.js';
import { testDatabase, resetTestDatabase } from '../support/database.js';
import { testPassword } from '../support/management.js';
const cfg = testDatabase(),
  pool = createPool(cfg.connection('runtime')),
  migration = createPool(cfg.connection('migrator'));
const origin = 'http://127.0.0.1:3100';
const app = createApp({
  ready: async () => true,
  logger: pino({ level: 'silent' }),
  database: { pool, auth: { origin, insecureLoopback: true } },
});
type Auth = { cookie: string; csrf: string; id: string };
let admin: Auth, manager: Auth, cashier: Auth, cashier2: Auth, inventory: Auth;
let branch: string,
  otherBranch: string,
  base: string,
  unit: string,
  tax: string,
  session1: string,
  session2: string;
const get = (path: string, a = admin) =>
  request(app)
    .get('/api/v1' + path)
    .set('Cookie', a.cookie);
const send = (
  path: string,
  data: object,
  a = admin,
  method: 'post' | 'put' = 'post',
) => {
  const agent = request(app);
  return agent[method]('/api/v1' + path)
    .set('Cookie', a.cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', a.csrf)
    .send(data);
};
async function login(name: string): Promise<Auth> {
  const r = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ username: name, password: testPassword });
  expect(r.status, r.text).toBe(200);
  return {
    cookie: (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
    csrf: r.body.csrfToken as string,
    id: r.body.user.id as string,
  };
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
async function terminal() {
  const code = 'T' + randomUUID().slice(0, 8).toUpperCase();
  const t = await send(`/branches/${branch}/terminals`, { code });
  expect(t.status, t.text).toBe(200);
  const r = await send(`/branches/${branch}/registers`, {
    terminalId: t.body.id,
    code: 'R' + code,
  });
  expect(r.status, r.text).toBe(200);
  return { terminalId: t.body.id as string, registerId: r.body.id as string };
}
async function open(a: Auth) {
  const t = await terminal();
  const r = await send(
    `${base}/sessions`,
    { requestKey: randomUUID(), registerId: t.registerId, openingFloat: '500' },
    a,
  );
  expect(r.status, r.text).toBe(200);
  return r.body.id as string;
}
async function product(
  stock = '10',
  conversion = '1',
  price = '112',
  taxCodeId: string | null = tax,
) {
  const sku = 'SALE-' + randomUUID().slice(0, 8).toUpperCase();
  const r = await send('/catalog/variants', {
    productName: 'Checkout fixture',
    name: 'Standard',
    sku,
    unitId: unit,
    conversion,
    fractional: false,
    minimumStock: '0',
    taxCodeId,
    categoryId: null,
    brandId: null,
    barcodes: [sku],
    archived: false,
  });
  expect(r.status, r.text).toBe(200);
  const id = r.body.id as string;
  expect(
    (
      await send(
        `/branches/${branch}/prices/${id}`,
        { version: 0, amount: price },
        admin,
        'put',
      )
    ).status,
  ).toBe(200);
  if (stock !== '0')
    await withTransaction(pool, async (tx) =>
      applyMovement(tx, {
        installationId: await installation(tx, branch),
        branchId: branch,
        variantId: id,
        condition: 'sellable',
        quantity: stock,
        unitCost: '10',
        sourceType: 'synthetic',
        sourceId: randomUUID(),
        sourceLineId: randomUUID(),
        actorId: admin.id,
      }),
    );
  return id;
}
async function cart(
  variantId: string,
  quantity = '1',
  discount = '0',
  a = cashier,
  sessionId = session1,
  customerId: string | null = null,
) {
  const input = {
    sessionId,
    customerId,
    lines: [{ variantId, quantity, discount }],
  };
  const r = await send(
    `${base}/carts`,
    { requestKey: randomUUID(), cart: input },
    a,
  );
  expect(r.status, r.text).toBe(200);
  return { ...(r.body as { id: string; version: number }), input };
}
const payments = (amount = '112') => [
  { method: 'cash', amount, reference: '' },
];
const post = (
  id: string,
  a = cashier,
  version = 1,
  key = randomUUID(),
  tenders = payments(),
) =>
  send(
    `${base}/carts/${id}/post`,
    { version, requestKey: key, payments: tenders },
    a,
  );
const approve = (id: string, version = 1, a = manager) =>
  send(
    `${base}/carts/${id}/approve-discount`,
    {
      version,
      requestKey: randomUUID(),
      password: testPassword,
      reason: 'Synthetic discount review',
    },
    a,
  );
beforeAll(async () => {
  await resetTestDatabase();
  await migrate(migration, { targetVersion: 6 });
  const seeded = await seedDemo(migration, {
    username: 'test.admin',
    displayName: 'Synthetic administrator',
    password: testPassword,
  });
  [branch, otherBranch] = seeded.branches as [string, string];
  await migrate(migration);
  expect(
    (await migration.query('SELECT count(*)::int count FROM sales')).rows[0]
      .count,
  ).toBe(0);
  base = `/branches/${branch}/checkout`;
  admin = await login('test.admin');
  manager = await user('checkout.manager', 'manager');
  cashier = await user('checkout.cashier', 'cashier');
  cashier2 = await user('checkout.cashier2', 'cashier');
  inventory = await user('checkout.inventory', 'inventory');
  unit = (await pool.query('SELECT id FROM product_units LIMIT 1')).rows[0]
    .id as string;
  const taxR = await send('/catalog/taxes', {
    code: 'SALE_VAT',
    name: 'Synthetic 12 percent',
    rate: '0.12',
    inclusive: true,
    archived: false,
  });
  expect(taxR.status, taxR.text).toBe(200);
  tax = taxR.body.id as string;
  expect(
    (
      await send(
        '/settings/business',
        {
          version: 1,
          name: 'Synthetic shop',
          address: 'Test only',
          currency: 'PHP',
          timezone: 'Asia/Manila',
          receiptFooter: 'Synthetic receipt',
          receiptSeries: 'SALE',
          taxConfirmed: true,
        },
        admin,
        'put',
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await send(
        `/branches/${branch}/settings`,
        {
          version: 1,
          tenders: ['cash', 'card', 'ewallet'],
          discountThreshold: '0',
          printerName: '',
          paperWidth: '80',
        },
        admin,
        'put',
      )
    ).status,
  ).toBe(200);
  session1 = await open(cashier);
  session2 = await open(cashier2);
});
beforeEach(async () => {
  await migration.query('DELETE FROM login_throttles');
});
afterAll(async () => {
  await pool.end();
  await migration.end();
});
describe('checkout and committed receipts', () => {
  it('lets till transactions share stable authority while blocking permission changes', async () => {
    await withTransaction(pool, async (first) => {
      await authLock(first, true);
      await withTransaction(pool, async (second) => {
        await authLock(second, true);
      });
      await expect(
        withTransaction(pool, async (writer) => {
          await writer.query("SET LOCAL lock_timeout='100ms'");
          await writer.query(
            "DELETE FROM role_permissions WHERE role_code='manager' AND permission_code='checkout.approve'",
          );
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    });
    await withTransaction(pool, async (tx) => {
      await authLock(tx);
    });
  });
  it('opens exactly one session per terminal and records its float once', async () => {
    const t = await terminal(),
      key = randomUUID(),
      input = {
        requestKey: key,
        registerId: t.registerId,
        openingFloat: '150.25',
      };
    const [a, b] = await Promise.all([
      send(`${base}/sessions`, input, cashier),
      send(`${base}/sessions`, input, cashier),
    ]);
    expect(a.status, a.text).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const alt = await send(`/branches/${branch}/registers`, {
      terminalId: t.terminalId,
      code: 'ALT' + randomUUID().slice(0, 6).toUpperCase(),
    });
    expect(
      (
        await send(
          `${base}/sessions`,
          { ...input, registerId: alt.body.id, requestKey: randomUUID() },
          cashier2,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await pool.query(
          'SELECT amount FROM register_cash_entries WHERE session_id=$1',
          [a.body.id],
        )
      ).rows,
    ).toEqual([{ amount: '150.25' }]);
  });
  it('posts a reviewed pack sale, split payment, exact stock cost and customer history only once', async () => {
    const v = await product('30', '6');
    const cust = await send(`/branches/${branch}/customers`, {
      name: 'Synthetic buyer',
      contact: '',
      archived: false,
    });
    const c = await cart(
      v,
      '2',
      '22.40',
      cashier,
      session1,
      cust.body.id as string,
    );
    expect(
      (await post(c.id, cashier, 1, randomUUID(), payments('201.60'))).status,
    ).toBe(409);
    expect((await approve(c.id)).status).toBe(200);
    const key = randomUUID(),
      tenders = [
        { method: 'card', amount: '100', reference: 'SYNTHETIC-AUTH' },
        { method: 'cash', amount: '150', reference: '' },
      ];
    const [a, b] = await Promise.all([
      post(c.id, cashier, 1, key, tenders),
      post(c.id, cashier, 1, key, tenders),
    ]);
    expect(a.status, a.text).toBe(200);
    expect(b.body).toEqual(a.body);
    expect((await post(c.id, cashier, 1, key, payments('201.60'))).status).toBe(
      409,
    );
    const d = (await get(`/branches/${branch}/sales/${a.body.id}`, cashier))
      .body;
    expect(d.sale).toMatchObject({
      net: '180.00',
      tax: '21.60',
      total: '201.60',
      change: '48.40',
      cash_effect: '101.60',
      discount: '22.40',
    });
    expect(d.lines[0]).toMatchObject({
      quantity: '2.000000',
      base_quantity: '12.000000',
    });
    expect(
      (
        await pool.query('SELECT cost FROM sale_items WHERE sale_id=$1', [
          a.body.id,
        ])
      ).rows,
    ).toEqual([{ cost: '120.000000' }]);
    expect(
      (
        await pool.query(
          "SELECT quantity,value FROM inventories WHERE variant_id=$1 AND condition='sellable'",
          [v],
        )
      ).rows,
    ).toEqual([{ quantity: '18.000000', value: '180.000000' }]);
    expect(
      (
        await pool.query(
          'SELECT amount FROM register_cash_entries WHERE sale_id=$1',
          [a.body.id],
        )
      ).rows,
    ).toEqual([{ amount: '101.60' }]);
    expect(
      (
        await get(
          `/branches/${branch}/customers/${cust.body.id}/history`,
          cashier,
        )
      ).body[0],
    ).toMatchObject({
      source_type: 'sale',
      source_id: a.body.id,
      amount: '201.60',
    });
    expect((await get(`${base}/requests/${key}`, cashier)).body.sale).toEqual(
      a.body,
    );
    expect(
      (await get(`${base}/requests/${key}`, cashier2)).body.sale,
    ).toBeNull();
    expect((await post(c.id, cashier, 1, randomUUID(), tenders)).status).toBe(
      409,
    );
    await expect(
      pool.query('UPDATE sales SET total=0 WHERE id=$1', [a.body.id]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM sale_items WHERE sale_id=$1', [a.body.id]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO sale_payments(id,sale_id,method,amount,applied,reference) VALUES($1,$2,'ewallet',1,1,'LATE')",
        [randomUUID(), a.body.id],
      ),
    ).rejects.toThrow('immutable');
  });
  it('allows only one of two tills to sell the last available unit', async () => {
    const v = await product('1');
    const a = await cart(v),
      b = await cart(v, '1', '0', cashier2, session2);
    const results = await Promise.all([post(a.id), post(b.id, cashier2)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await pool.query(
          "SELECT quantity,value FROM inventories WHERE variant_id=$1 AND condition='sellable'",
          [v],
        )
      ).rows,
    ).toEqual([{ quantity: '0.000000', value: '0.000000' }]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM inventory_movements WHERE variant_id=$1 AND source_type='sale'",
          [v],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('enforces branch, cashier, reviewer, transport and permission boundaries', async () => {
    const c = await cart(await product());
    expect((await get(`${base}/options`, inventory)).status).toBe(403);
    expect(
      (await get(`/branches/${otherBranch}/checkout/carts/${c.id}`, cashier))
        .status,
    ).toBe(403);
    expect(
      (await get(`/branches/${otherBranch}/checkout/carts/${c.id}`)).status,
    ).toBe(404);
    expect((await post(c.id, cashier2)).status).toBe(403);
    expect(
      (
        await send(
          `${base}/carts`,
          { requestKey: randomUUID(), cart: c.input },
          cashier2,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/v1${base}/carts/${c.id}/post`)
          .set('Cookie', cashier.cookie)
          .set('Origin', origin)
          .send({ version: 1, requestKey: randomUUID(), payments: payments() })
      ).status,
    ).toBe(403);
    const ms = await open(manager),
      discounted = await cart(await product(), '1', '1', manager, ms);
    expect((await approve(discounted.id, 1, manager)).status).toBe(403);
    expect((await approve(discounted.id, 1, cashier)).status).toBe(403);
    expect(
      (
        await send(
          `${base}/carts/${discounted.id}/approve-discount`,
          {
            version: 1,
            requestKey: randomUUID(),
            password: 'incorrect',
            reason: 'Test',
          },
          admin,
        )
      ).status,
    ).toBe(409);
  });
  it('invalidates discounts on edit, expiry, changed prices or revoked reviewer authority', async () => {
    const v = await product(),
      c = await cart(v, '1', '1');
    expect((await approve(c.id)).status).toBe(200);
    expect(
      (
        await send(
          `${base}/carts/${c.id}`,
          {
            version: 1,
            cart: {
              ...c.input,
              lines: [{ variantId: v, quantity: '2', discount: '2' }],
            },
          },
          cashier,
          'put',
        )
      ).status,
    ).toBe(200);
    expect(
      (await post(c.id, cashier, 2, randomUUID(), payments('222'))).status,
    ).toBe(409);
    const approval = await approve(c.id, 2);
    expect(approval.status).toBe(200);
    await migration.query(
      'ALTER TABLE checkout_approvals DISABLE TRIGGER immutable_rows',
    );
    try {
      await migration.query(
        "UPDATE checkout_approvals SET expires_at=now()-interval '1 second' WHERE id=$1",
        [approval.body.id],
      );
    } finally {
      await migration.query(
        'ALTER TABLE checkout_approvals ENABLE TRIGGER immutable_rows',
      );
    }
    expect(
      (await post(c.id, cashier, 2, randomUUID(), payments('222'))).status,
    ).toBe(409);
    expect((await approve(c.id, 2)).status).toBe(200);
    await migration.query(
      "DELETE FROM role_permissions WHERE role_code='manager' AND permission_code='checkout.approve'",
    );
    try {
      expect(
        (await post(c.id, cashier, 2, randomUUID(), payments('222'))).status,
      ).toBe(409);
    } finally {
      await migration.query(
        "INSERT INTO role_permissions VALUES('manager','checkout.approve')",
      );
    }
    expect(
      (
        await send(
          `/branches/${branch}/prices/${v}`,
          { version: 1, amount: '113' },
          admin,
          'put',
        )
      ).status,
    ).toBe(200);
    expect(
      (await post(c.id, cashier, 2, randomUUID(), payments('224'))).status,
    ).toBe(409);
  });
  it('holds, resumes and cancels drafts without moving stock; rejects stale versions and bad tenders', async () => {
    const v = await product(),
      c = await cart(v);
    const act = (action: string, version: number) =>
      send(
        `${base}/carts/${c.id}/${action}`,
        { version, requestKey: randomUUID() },
        cashier,
      );
    expect((await act('hold', 1)).status).toBe(200);
    expect((await post(c.id, cashier, 2)).status).toBe(409);
    expect((await act('resume', 2)).status).toBe(200);
    expect((await post(c.id)).status).toBe(409);
    expect(
      (
        await post(c.id, cashier, 3, randomUUID(), [
          { method: 'card', amount: '112', reference: '' },
        ])
      ).status,
    ).toBe(409);
    expect(
      (
        await post(c.id, cashier, 3, randomUUID(), [
          { method: 'ewallet', amount: '113', reference: 'REF' },
        ])
      ).status,
    ).toBe(409);
    expect(
      (await post(c.id, cashier, 3, randomUUID(), payments('111'))).status,
    ).toBe(409);
    expect((await act('cancel', 3)).status).toBe(200);
    expect((await post(c.id, cashier, 4)).status).toBe(409);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM inventory_movements WHERE variant_id=$1 AND source_type='sale'",
          [v],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('blocks reserved, frozen, archived and closed-register stock use', async () => {
    const v = await product('1'),
      c = await cart(v);
    const reservation = await send(
      `/branches/${branch}/inventory/reservations`,
      {
        requestKey: randomUUID(),
        variantId: v,
        quantity: '1',
        reference: 'TEST',
      },
    );
    expect(reservation.status, reservation.text).toBe(200);
    expect((await post(c.id)).status).toBe(409);
    expect(
      (
        await send(
          `/branches/${branch}/inventory/reservations/${reservation.body.id}/release`,
          { requestKey: randomUUID() },
        )
      ).status,
    ).toBe(200);
    const count = await send(`/branches/${branch}/inventory/documents`, {
      requestKey: randomUUID(),
      document: {
        kind: 'count',
        reasonCode: 'COUNT_VARIANCE',
        note: 'Checkout freeze',
        lines: [
          { variantId: v, condition: 'sellable', quantity: '1', unitCost: '0' },
        ],
      },
    });
    expect(count.status, count.text).toBe(200);
    expect((await post(c.id)).status).toBe(409);
    expect(
      (
        await send(
          `/branches/${branch}/inventory/documents/${count.body.id}/cancel`,
          { version: 1, requestKey: randomUUID() },
        )
      ).status,
    ).toBe(200);
    await migration.query(
      'UPDATE product_variants SET archived=true WHERE id=$1',
      [v],
    );
    expect((await post(c.id)).status).toBe(409);
    await migration.query(
      'UPDATE product_variants SET archived=false WHERE id=$1',
      [v],
    );
    await migration.query(
      "UPDATE register_sessions SET status='closed' WHERE id=$1",
      [session1],
    );
    expect((await post(c.id)).status).toBe(409);
    await migration.query(
      "UPDATE register_sessions SET status='open' WHERE id=$1",
      [session1],
    );
    expect((await post(c.id)).status).toBe(200);
  });
  it('rolls back a late sale failure including cash, customer, stock, number and retry state', async () => {
    const v = await product(),
      customer = await send(`/branches/${branch}/customers`, {
        name: 'Rollback buyer',
        contact: '',
        archived: false,
      }),
      c = await cart(
        v,
        '1',
        '0',
        cashier,
        session1,
        customer.body.id as string,
      ),
      key = randomUUID();
    const postingTables = [
      'sales',
      'sale_items',
      'sale_payments',
      'register_cash_entries',
      'document_numbers',
      'audit_logs',
      'sync_queue',
      'customer_transactions',
    ];
    const counts = async () =>
      (
        await pool.query(
          postingTables
            .map(
              (table) =>
                `SELECT '${table}' AS name,count(*)::text count FROM ${table}`,
            )
            .join(' UNION ALL '),
        )
      ).rows;
    const before = await counts();
    await migration.query(
      "CREATE FUNCTION public.fail_sale_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='checkout.changed' AND NEW.payload->>'kind'='sale' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$",
    );
    await migration.query(
      'CREATE TRIGGER fail_sale BEFORE INSERT ON sync_queue FOR EACH ROW EXECUTE FUNCTION fail_sale_event()',
    );
    try {
      expect((await post(c.id, cashier, 1, key)).status).toBe(500);
    } finally {
      await migration.query('DROP TRIGGER fail_sale ON sync_queue');
      await migration.query('DROP FUNCTION fail_sale_event()');
    }
    expect(await counts()).toEqual(before);
    expect(
      (await get(`${base}/requests/${key}`, cashier)).body.sale,
    ).toBeNull();
    expect((await get(`${base}/carts/${c.id}`, cashier)).body.cart.status).toBe(
      'active',
    );
    expect(
      (
        await pool.query(
          'SELECT 1 FROM customer_transactions WHERE customer_id=$1',
          [customer.body.id],
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
          "SELECT 1 FROM inventory_movements WHERE variant_id=$1 AND source_type='sale'",
          [v],
        )
      ).rowCount,
    ).toBe(0);
    expect((await post(c.id, cashier, 1, key)).status).toBe(200);
    expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
  });
  it('rechecks tax confirmation, current tax rates, customer availability and enabled tenders', async () => {
    const v = await product(),
      buyer = await send(`/branches/${branch}/customers`, {
        name: 'Configuration buyer',
        contact: '',
        archived: false,
      });
    const c = await cart(
      v,
      '1',
      '0',
      cashier,
      session1,
      buyer.body.id as string,
    );
    await migration.query(
      "UPDATE business_settings SET value=jsonb_set(value,'{taxConfirmed}','false')",
    );
    try {
      expect((await post(c.id)).status).toBe(409);
    } finally {
      await migration.query(
        "UPDATE business_settings SET value=jsonb_set(value,'{taxConfirmed}','true')",
      );
    }
    await migration.query('UPDATE customers SET archived=true WHERE id=$1', [
      buyer.body.id,
    ]);
    try {
      expect((await post(c.id)).status).toBe(404);
    } finally {
      await migration.query('UPDATE customers SET archived=false WHERE id=$1', [
        buyer.body.id,
      ]);
    }
    await migration.query(
      'UPDATE tax_codes SET rate=0.10,version=version+1 WHERE id=$1',
      [tax],
    );
    try {
      expect((await post(c.id)).status).toBe(409);
    } finally {
      await migration.query(
        'UPDATE tax_codes SET rate=0.12,version=version+1 WHERE id=$1',
        [tax],
      );
    }
    const settings = (
      await pool.query('SELECT value FROM branch_settings WHERE branch_id=$1', [
        branch,
      ])
    ).rows[0].value as Record<string, unknown>;
    await migration.query(
      'UPDATE branch_settings SET value=$2 WHERE branch_id=$1',
      [branch, JSON.stringify({ ...settings, tenders: ['cash'] })],
    );
    try {
      const cashOnly = await cart(v);
      expect(
        (
          await post(cashOnly.id, cashier, 1, randomUUID(), [
            { method: 'card', amount: '112', reference: 'REF' },
          ])
        ).status,
      ).toBe(409);
    } finally {
      await migration.query(
        'UPDATE branch_settings SET value=$2 WHERE branch_id=$1',
        [branch, JSON.stringify(settings)],
      );
    }
  });
  it('retains committed snapshots and append-only failed/reprinted receipt history', async () => {
    const v = await product(),
      c = await cart(v),
      sale = await post(c.id);
    expect(sale.status, sale.text).toBe(200);
    const path = `/branches/${branch}/sales/${sale.body.id}`;
    const before = (await get(path, cashier)).body;
    expect(
      (
        await get(`/branches/${branch}/sales?unprinted=true`, cashier)
      ).body.rows.some((r: { id: string }) => r.id === sale.body.id),
    ).toBe(true);
    expect(
      (
        await send(
          `/branches/${branch}/prices/${v}`,
          { version: 1, amount: '120' },
          admin,
          'put',
        )
      ).status,
    ).toBe(200);
    expect((await get(path, cashier)).body.lines).toEqual(before.lines);
    const input = {
      requestKey: randomUUID(),
      outcome: 'requested',
      attemptId: null,
    };
    const attempt = await send(path + '/print', input, cashier);
    expect(attempt.status, attempt.text).toBe(200);
    expect((await send(path + '/print', input, cashier)).body.id).toBe(
      attempt.body.id,
    );
    expect(
      (
        await send(
          path + '/print',
          {
            requestKey: randomUUID(),
            outcome: 'failed',
            attemptId: attempt.body.id,
          },
          cashier,
        )
      ).status,
    ).toBe(200);
    const second = await send(
      path + '/print',
      { ...input, requestKey: randomUUID() },
      cashier,
    );
    expect(
      (
        await send(
          path + '/print',
          {
            requestKey: randomUUID(),
            outcome: 'confirmed',
            attemptId: second.body.id,
          },
          cashier2,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          path + '/print',
          {
            requestKey: randomUUID(),
            outcome: 'confirmed',
            attemptId: second.body.id,
          },
          cashier,
        )
      ).status,
    ).toBe(200);
    expect((await get(path, cashier)).body.prints).toHaveLength(4);
    expect(
      (
        await get(`/branches/${branch}/sales?unprinted=true`, cashier)
      ).body.rows.some((r: { id: string }) => r.id === sale.body.id),
    ).toBe(false);
    expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
  });
});
