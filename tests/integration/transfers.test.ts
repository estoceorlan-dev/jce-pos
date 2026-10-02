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
import { conservation } from '../../backend/src/transfers/service.js';
import { testDatabase, resetTestDatabase } from '../support/database.js';
import { testPassword } from '../support/management.js';
const cfg = testDatabase(),
  pool = createPool(cfg.connection('runtime')),
  migration = createPool(cfg.connection('migrator'));
const origin = 'http://127.0.0.1:3100',
  app = createApp({
    ready: async () => true,
    logger: pino({ level: 'silent' }),
    database: { pool, auth: { origin, insecureLoopback: true } },
  });
type Auth = { id: string; cookie: string; csrf: string };
let admin: Auth,
  source: Auth,
  destination: Auth,
  reviewer: Auth,
  destReviewer: Auth,
  cashier: Auth;
let a: string, b: string, unit: string, base: string, destBase: string;
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
async function login(username: string): Promise<Auth> {
  const r = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ username, password: testPassword });
  expect(r.status, r.text).toBe(200);
  return {
    id: r.body.user.id as string,
    cookie: (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
    csrf: r.body.csrfToken as string,
  };
}
async function user(name: string, role: string, branches: string[]) {
  const r = await send('/users', {
    username: name,
    displayName: name,
    password: testPassword,
    roles: [role],
    branchIds: branches,
  });
  expect(r.status, r.text).toBe(200);
  await migration.query(
    'UPDATE users SET must_change_password=false WHERE id=$1',
    [r.body.id],
  );
  return login(name);
}
async function variant(
  quantity = '10',
  value = '100',
  branch = a,
  fractional = false,
) {
  const r = await send('/catalog/variants', {
    productName: 'Transfer fixture',
    name: 'Standard',
    sku: 'TR-' + randomUUID().slice(0, 8).toUpperCase(),
    unitId: unit,
    conversion: '1',
    fractional,
    minimumStock: '0',
    taxCodeId: null,
    categoryId: null,
    brandId: null,
    barcodes: [],
    archived: false,
  });
  expect(r.status, r.text).toBe(200);
  const id = r.body.id as string;
  if (quantity !== '0') await stock(id, branch, quantity, value);
  return id;
}
async function stock(
  variantId: string,
  branch: string,
  quantity: string,
  value: string,
) {
  await withTransaction(pool, async (tx) =>
    applyMovement(tx, {
      installationId: await installation(tx, branch),
      branchId: branch,
      variantId,
      condition: 'sellable',
      quantity,
      unitCost: '0',
      valueChange: value,
      sourceType: 'synthetic',
      sourceId: randomUUID(),
      sourceLineId: randomUUID(),
      actorId: admin.id,
    }),
  );
}
async function draft(
  variantId: string,
  quantity = '3',
  auth = source,
  path = base,
  returnOfId: string | null = null,
) {
  const r = await send(
    path,
    {
      requestKey: randomUUID(),
      transfer: {
        destinationBranchId: path === base ? b : a,
        returnOfId,
        note: 'Synthetic transfer',
        lines: [{ variantId, quantity }],
      },
    },
    auth,
  );
  expect(r.status, r.text).toBe(200);
  return r.body as { id: string; version: number };
}
const action = (
  id: string,
  kind: string,
  version: number,
  auth = source,
  path = base,
  key = randomUUID(),
) =>
  send(
    `${path}/${id}/${kind}`,
    {
      requestKey: key,
      version,
      note: `Synthetic ${kind}`,
      ...(['approve', 'reject'].includes(kind)
        ? { password: testPassword }
        : {}),
    },
    auth,
  );
async function dispatched(
  variantId: string,
  quantity = '3',
  auth = source,
  path = base,
  returnOfId: string | null = null,
) {
  const d = await draft(variantId, quantity, auth, path, returnOfId);
  for (const [kind, version, actor] of [
    ['submit', 1, auth],
    ['approve', 2, reviewer],
    ['dispatch', 3, auth],
  ] as const) {
    const r = await action(d.id, kind, version, actor, path);
    expect(r.status, r.text).toBe(200);
  }
  const detail = await get(`${path}/${d.id}`, auth);
  expect(detail.status, detail.text).toBe(200);
  return { id: d.id, lineId: detail.body.lines[0].id as string, version: 4 };
}
const receipt = (
  t: { id: string; lineId: string },
  quantity: string,
  version: number,
  condition = 'sellable',
  auth = destination,
  path = destBase,
  key = randomUUID(),
) =>
  send(
    `${path}/${t.id}/receive`,
    {
      requestKey: key,
      version,
      note: 'Actual units received',
      lines: [{ transferItemId: t.lineId, quantity, condition }],
    },
    auth,
  );
const propose = (
  t: { id: string; lineId: string },
  quantity: string,
  version: number,
  resolution = 'lost',
  auth = destination,
) =>
  send(
    `${destBase}/${t.id}/discrepancies`,
    {
      requestKey: randomUUID(),
      version,
      note: 'Physical discrepancy confirmed',
      reasonCode: resolution === 'lost' ? 'MISSING' : 'RETURN_TO_SOURCE',
      lines: [
        {
          transferItemId: t.lineId,
          quantity,
          condition: 'damaged',
          resolution,
        },
      ],
    },
    auth,
  );
const resolve = (
  t: { id: string },
  requestId: string,
  version: number,
  auth = reviewer,
  key = randomUUID(),
) =>
  send(
    `${destBase}/${t.id}/discrepancies/${requestId}/resolve`,
    {
      requestKey: key,
      version,
      note: 'Independent exact resolution',
      password: testPassword,
    },
    auth,
  );
beforeAll(async () => {
  await resetTestDatabase();
  await migrate(migration, { targetVersion: 8 });
  const seeded = await seedDemo(migration, {
    username: 'test.admin',
    displayName: 'Synthetic admin',
    password: testPassword,
  });
  [a, b] = seeded.branches as [string, string];
  base = `/branches/${a}/transfers`;
  destBase = `/branches/${b}/transfers`;
  admin = await login('test.admin');
  unit = (await pool.query('SELECT id FROM product_units LIMIT 1')).rows[0]
    .id as string;
  const oldVariant = await variant();
  const old = await send(`/branches/${a}/inventory/reservations`, {
    requestKey: randomUUID(),
    variantId: oldVariant,
    quantity: '1',
    reference: 'Pre-L9 reservation',
  });
  expect(old.status, old.text).toBe(200);
  await migrate(migration);
  expect(
    (
      await pool.query(
        'SELECT status,transfer_item_id FROM inventory_reservations WHERE id=$1',
        [old.body.id],
      )
    ).rows[0],
  ).toEqual({ status: 'active', transfer_item_id: null });
  source = await user('transfer.source', 'inventory', [a]);
  destination = await user('transfer.destination', 'inventory', [b]);
  reviewer = await user('transfer.manager', 'manager', [a, b]);
  destReviewer = await user('transfer.destmanager', 'manager', [b]);
  cashier = await user('transfer.cashier', 'cashier', [a]);
}, 30000);
beforeEach(async () => {
  await migration.query('DELETE FROM login_throttles');
});
afterAll(async () => {
  await pool.end();
  await migration.end();
});
describe('local branch transfer lifecycle', () => {
  it('versions drafts, rejects unauthorized sides and requires independent approval', async () => {
    const v = await variant(),
      d = await draft(v);
    expect((await get(`${base}/${d.id}`, cashier)).status).toBe(403);
    expect((await get(`${destBase}/${d.id}`, source)).status).toBe(403);
    expect((await action(d.id, 'dispatch', 1)).status).toBe(409);
    const edit = {
      requestKey: randomUUID(),
      version: 1,
      transfer: {
        destinationBranchId: b,
        returnOfId: null,
        note: 'Edited draft',
        lines: [{ variantId: v, quantity: '4' }],
      },
    };
    expect((await send(`${base}/${d.id}`, edit, source, 'put')).status).toBe(
      200,
    );
    expect(
      (
        await send(
          `${base}/${d.id}`,
          { ...edit, requestKey: randomUUID() },
          source,
          'put',
        )
      ).status,
    ).toBe(409);
    expect((await action(d.id, 'submit', 2)).status).toBe(200);
    expect(
      (await action(d.id, 'approve', 3, destReviewer, destBase)).status,
    ).toBe(403);
    expect(
      (
        await send(
          `${base}/${d.id}/approve`,
          {
            requestKey: randomUUID(),
            version: 3,
            note: 'Review',
            password: 'incorrect',
          },
          reviewer,
        )
      ).status,
    ).toBe(409);
    expect((await action(d.id, 'reject', 3, reviewer)).status).toBe(200);
    expect((await action(d.id, 'submit', 4)).status).toBe(409);
    const own = await draft(v, '1', reviewer);
    expect((await action(own.id, 'submit', 1, reviewer)).status).toBe(200);
    expect((await action(own.id, 'approve', 2, reviewer)).status).toBe(403);
    expect((await action(own.id, 'cancel', 2, reviewer)).status).toBe(200);
  });
  it('reserves once under competing approvals and releases only through cancellation', async () => {
    const v = await variant('3', '30'),
      one = await draft(v),
      two = await draft(v);
    for (const d of [one, two])
      expect((await action(d.id, 'submit', 1)).status).toBe(200);
    const result = await Promise.all([
      action(one.id, 'approve', 2, reviewer),
      action(two.id, 'approve', 2, admin),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
    const id = result[0]!.status === 200 ? one.id : two.id;
    const reservation = (
      await pool.query(
        'SELECT r.id FROM inventory_reservations r JOIN stock_transfer_items i ON i.id=r.transfer_item_id WHERE i.transfer_id=$1',
        [id],
      )
    ).rows[0].id as string;
    expect(
      (
        await send(
          `/branches/${a}/inventory/reservations/${reservation}/release`,
          { requestKey: randomUUID() },
          source,
        )
      ).status,
    ).toBe(409);
    await expect(
      pool.query(
        "UPDATE inventory_reservations SET status='released',released_at=now() WHERE id=$1",
        [reservation],
      ),
    ).rejects.toThrow();
    await expect(stock(v, a, '-1', '-10')).rejects.toThrow();
    expect((await action(id, 'cancel', 3)).status).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT quantity,reserved FROM inventories WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
          [a, v],
        )
      ).rows[0],
    ).toEqual({ quantity: '3.000000', reserved: '0.000000' });
  });
  it('snapshots cost at dispatch, preserves reservations across failure and deduplicates dispatch', async () => {
    const v = await variant('3', '30'),
      d = await draft(v);
    expect((await action(d.id, 'submit', 1)).status).toBe(200);
    expect((await action(d.id, 'approve', 2, reviewer)).status).toBe(200);
    await stock(v, a, '3', '60');
    const key = randomUUID(),
      results = await Promise.all([
        action(d.id, 'dispatch', 3, source, base, key),
        action(d.id, 'dispatch', 3, source, base, key),
      ]);
    for (const r of results) expect(r.status, r.text).toBe(200);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect((await conservation(pool, d.id))[0]).toMatchObject({
      shipped_quantity: '3.000000',
      shipped_value: '45.000000',
      transit_quantity: '3.000000',
      transit_value: '45.000000',
      matched: true,
    });
    expect((await action(d.id, 'dispatch', 3)).status).toBe(409);
    expect((await action(d.id, 'cancel', 4)).status).toBe(409);
    await expect(
      pool.query(
        'UPDATE transfer_shipment_items SET value=0 WHERE transfer_id=$1',
        [d.id],
      ),
    ).rejects.toThrow();
  });
  it('receives only actual quantities with exact rounding residue, conditions and retry recovery', async () => {
    const v = await variant('3', '10'),
      t = await dispatched(v);
    await migration.query(
      'UPDATE product_variants SET archived=true WHERE id=$1',
      [v],
    );
    const key = randomUUID(),
      r = await receipt(t, '1', 4, 'sellable', destination, destBase, key);
    expect(r.status, r.text).toBe(200);
    expect(
      (await receipt(t, '1', 4, 'sellable', destination, destBase, key)).body,
    ).toEqual(r.body);
    expect(
      (await receipt(t, '2', 4, 'sellable', destination, destBase, key)).status,
    ).toBe(409);
    expect(
      (await get(`${destBase}/${t.id}`, destination)).body.transfer.status,
    ).toBe('partially_received');
    expect((await receipt(t, '3', 5)).status).toBe(409);
    expect((await receipt(t, '1', 5, 'damaged')).status).toBe(200);
    expect((await receipt(t, '1', 6, 'quarantined')).status).toBe(200);
    const detail = await get(`${destBase}/${t.id}`, destination);
    expect(detail.body.transfer.status).toBe('received');
    expect(
      detail.body.receiptItems.map((l: { value: string }) => l.value).sort(),
    ).toEqual(['3.333333', '3.333333', '3.333334']);
    expect(detail.body.ledger[0]).toMatchObject({
      received_quantity: '3.000000',
      received_value: '10.000000',
      transit_quantity: '0.000000',
      transit_value: '0.000000',
      matched: true,
    });
    expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
    await expect(
      pool.query(
        "INSERT INTO transfer_receipt_items(id,receipt_id,transfer_id,transfer_item_id,quantity,value,condition) VALUES($1,$2,$3,$4,1,1,'sellable')",
        [randomUUID(), r.body.id, t.id, t.lineId],
      ),
    ).rejects.toThrow();
  });
  it('serializes different concurrent receipts and denies source/nested-object misuse', async () => {
    const t = await dispatched(await variant(), '3'),
      other = await dispatched(await variant(), '1');
    expect((await receipt(t, '1', 4, 'sellable', source, base)).status).toBe(
      403,
    );
    expect((await receipt({ ...t, lineId: other.lineId }, '1', 4)).status).toBe(
      404,
    );
    const r = await Promise.all([receipt(t, '2', 4), receipt(t, '2', 4)]);
    expect(r.map((v) => v.status).sort()).toEqual([200, 409]);
    expect((await conservation(pool, t.id))[0]).toMatchObject({
      received_quantity: '2.000000',
      transit_quantity: '1.000000',
      matched: true,
    });
  });
  it('keeps shortages in transit until a different reviewer posts an unchanged resolution', async () => {
    const t = await dispatched(await variant());
    expect((await receipt(t, '1', 4)).status).toBe(200);
    const stale = await propose(t, '2', 5, 'lost', destReviewer);
    expect(stale.status, stale.text).toBe(200);
    expect(
      (await resolve(t, stale.body.id as string, 6, destReviewer)).status,
    ).toBe(403);
    expect((await receipt(t, '1', 6)).status).toBe(200);
    expect((await resolve(t, stale.body.id as string, 7)).status).toBe(409);
    const fresh = await propose(t, '1', 7);
    expect(fresh.status, fresh.text).toBe(200);
    const key = randomUUID(),
      posted = await resolve(t, fresh.body.id as string, 8, reviewer, key);
    expect(posted.status, posted.text).toBe(200);
    expect(
      (await resolve(t, fresh.body.id as string, 8, reviewer, key)).body,
    ).toEqual(posted.body);
    expect((await conservation(pool, t.id))[0]).toMatchObject({
      received_quantity: '2.000000',
      lost_quantity: '1.000000',
      lost_value: '10.000000',
      transit_quantity: '0.000000',
      matched: true,
    });
    expect(
      (await get(`${destBase}/${t.id}`, destination)).body.transfer.status,
    ).toBe('received');
  });
  it('requires rights on both branches to return in-transit damaged goods to source', async () => {
    const v = await variant(),
      t = await dispatched(v),
      p = await propose(t, '3', 4, 'return_to_source');
    expect(p.status, p.text).toBe(200);
    expect(
      (await resolve(t, p.body.id as string, 5, destReviewer)).status,
    ).toBe(409);
    expect((await resolve(t, p.body.id as string, 5)).status).toBe(200);
    expect((await conservation(pool, t.id))[0]).toMatchObject({
      returned_quantity: '3.000000',
      returned_value: '30.000000',
      transit_quantity: '0.000000',
      matched: true,
    });
    expect(
      (
        await pool.query(
          "SELECT quantity,value FROM inventories WHERE branch_id=$1 AND variant_id=$2 AND condition='damaged'",
          [a, v],
        )
      ).rows[0],
    ).toEqual({ quantity: '3.000000', value: '30.000000' });
  });
  it('runs linked return transfers through the full lifecycle and caps original sellable receipts', async () => {
    const v = await variant(),
      t = await dispatched(v);
    expect((await receipt(t, '2', 4)).status).toBe(200);
    expect((await receipt(t, '1', 5, 'damaged')).status).toBe(200);
    const back = await dispatched(v, '2', destination, destBase, t.id);
    expect((await receipt(back, '2', 4, 'sellable', source, base)).status).toBe(
      200,
    );
    expect(
      (
        await send(
          destBase,
          {
            requestKey: randomUUID(),
            transfer: {
              destinationBranchId: a,
              returnOfId: t.id,
              note: 'Excess original return',
              lines: [{ variantId: v, quantity: '1' }],
            },
          },
          destination,
        )
      ).status,
    ).toBe(409);
    expect(
      (await get(`${base}/${t.id}`, source)).body.returns[0],
    ).toMatchObject({ id: back.id, status: 'received' });
    expect((await conservation(pool, back.id))[0]?.matched).toBe(true);
    expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
  });
  it('rolls back a late receipt failure including destination stock, numbering, audit and retry state', async () => {
    const t = await dispatched(await variant()),
      before = (await conservation(pool, t.id))[0],
      key = randomUUID();
    await migration.query(
      `CREATE FUNCTION public.fail_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='receipt' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_transfer BEFORE INSERT ON transfer_transit_entries FOR EACH ROW EXECUTE FUNCTION public.fail_transfer()`,
    );
    try {
      expect(
        (await receipt(t, '1', 4, 'sellable', destination, destBase, key))
          .status,
      ).toBe(500);
    } finally {
      await migration.query(
        'DROP TRIGGER fail_transfer ON transfer_transit_entries; DROP FUNCTION public.fail_transfer()',
      );
    }
    expect((await conservation(pool, t.id))[0]).toEqual(before);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM transfer_receipts WHERE transfer_id=$1',
          [t.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await receipt(t, '1', 4, 'sellable', destination, destBase, key)).status,
    ).toBe(200);
    expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
  });
  it('respects stock-count freezes and supports simultaneous opposite-direction transfers', async () => {
    const v = await variant(),
      d = await draft(v);
    expect((await action(d.id, 'submit', 1)).status).toBe(200);
    expect((await action(d.id, 'approve', 2, reviewer)).status).toBe(200);
    const count = await send(
      `/branches/${a}/inventory/documents`,
      {
        requestKey: randomUUID(),
        document: {
          kind: 'count',
          reasonCode: 'COUNT_VARIANCE',
          note: 'Synthetic count',
          lines: [
            {
              variantId: v,
              condition: 'sellable',
              quantity: '10',
              unitCost: '0',
            },
          ],
        },
      },
      source,
    );
    expect(count.status, count.text).toBe(200);
    expect((await action(d.id, 'dispatch', 3)).status).toBe(409);
    expect(
      (
        await send(
          `/branches/${a}/inventory/documents/${count.body.id}/cancel`,
          { requestKey: randomUUID(), version: 1 },
          source,
        )
      ).status,
    ).toBe(200);
    await stock(v, b, '10', '100');
    const back = await draft(v, '3', destination, destBase);
    expect(
      (await action(back.id, 'submit', 1, destination, destBase)).status,
    ).toBe(200);
    expect(
      (await action(back.id, 'approve', 2, reviewer, destBase)).status,
    ).toBe(200);
    const r = await Promise.all([
      action(d.id, 'dispatch', 3),
      action(back.id, 'dispatch', 3, destination, destBase),
    ]);
    for (const result of r) expect(result.status, result.text).toBe(200);
    expect((await reconcile(pool)).every((row) => row.matched)).toBe(true);
  });
  it('blocks approval and dispatch to an archived destination while allowing pre-shipment cancellation', async () => {
    const t = await draft(await variant());
    expect((await action(t.id, 'submit', 1)).status).toBe(200);
    try {
      await migration.query(
        'UPDATE branches SET archived_at=now() WHERE id=$1',
        [b],
      );
      expect((await action(t.id, 'approve', 2, reviewer)).status).toBe(409);
      await migration.query(
        'UPDATE branches SET archived_at=NULL WHERE id=$1',
        [b],
      );
      expect((await action(t.id, 'approve', 2, reviewer)).status).toBe(200);
      await migration.query(
        'UPDATE branches SET archived_at=now() WHERE id=$1',
        [b],
      );
      expect((await action(t.id, 'dispatch', 3)).status).toBe(409);
      expect((await action(t.id, 'cancel', 3)).status).toBe(200);
      expect((await get(`${base}/${t.id}`, source)).body.transfer.status).toBe(
        'cancelled',
      );
      expect((await reconcile(pool)).every((r) => r.matched)).toBe(true);
    } finally {
      await migration.query(
        'UPDATE branches SET archived_at=NULL WHERE id=$1',
        [b],
      );
    }
  });
  it('rejects same-branch and independent-installation destinations', async () => {
    const v = await variant();
    const payload = {
      requestKey: randomUUID(),
      transfer: {
        destinationBranchId: a,
        returnOfId: null,
        note: 'Invalid destination',
        lines: [{ variantId: v, quantity: '1' }],
      },
    };
    expect((await send(base, payload, source)).status).toBe(409);
    expect(
      (
        await send(
          base,
          {
            ...payload,
            transfer: {
              ...payload.transfer,
              destinationBranchId: randomUUID(),
            },
          },
          source,
        )
      ).status,
    ).toBe(409);
    const foreign = randomUUID(),
      remote = randomUUID();
    await expect(
      migration.query(
        'INSERT INTO installations(id,singleton) VALUES($1,false)',
        [remote],
      ),
    ).rejects.toThrow();
    await expect(
      migration.query(
        "INSERT INTO branches(id,code,name) VALUES($1,'REMOTE_TEST','Unowned destination fixture')",
        [foreign],
      ),
    ).rejects.toThrow('Branch requires an owner installation');
    expect(
      (
        await send(
          base,
          {
            ...payload,
            transfer: { ...payload.transfer, destinationBranchId: foreign },
          },
          source,
        )
      ).status,
    ).toBe(409);
    expect(
      (await get(base + '/options', source)).body.branches.some(
        (r: { id: string }) => r.id === foreign,
      ),
    ).toBe(false);
  });
});
