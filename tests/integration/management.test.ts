import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../backend/src/app.js';
import { createPool } from '../../backend/src/db/pool.js';
import {
  bootstrapAdministrator,
  digest,
} from '../../backend/src/auth/service.js';
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
let branchA: string;
let branchB: string;
let unitId: string;
async function login(name = 'test.admin', secret = testPassword) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ username: name, password: secret });
  expect(res.status, res.text).toBe(200);
  return {
    cookie: (res.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!,
    csrf: res.body.csrfToken as string,
    id: res.body.user.id as string,
  };
}
const get = (path: string, auth = admin) =>
  request(app)
    .get('/api/v1' + path)
    .set('Cookie', auth.cookie);
const post = (path: string, data: object = {}, auth = admin) =>
  request(app)
    .post('/api/v1' + path)
    .set('Cookie', auth.cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', auth.csrf)
    .send(data);
const put = (path: string, data: object, auth = admin) =>
  request(app)
    .put('/api/v1' + path)
    .set('Cookie', auth.cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', auth.csrf)
    .send(data);
async function makeUser(name: string, role: string, branches = [branchA]) {
  const res = await post('/users', {
    username: name,
    displayName: name,
    password: testPassword,
    roles: [role],
    branchIds: branches,
  });
  expect(res.status, res.text).toBe(200);
  await migration.query(
    'UPDATE users SET must_change_password=false WHERE id=$1',
    [res.body.id],
  );
  return login(name);
}
const variant = (sku: string, extra = {}) => ({
  productName: 'Test product',
  name: 'Standard',
  sku,
  unitId,
  conversion: '1',
  fractional: false,
  minimumStock: '0',
  taxCodeId: null,
  categoryId: null,
  brandId: null,
  barcodes: [],
  archived: false,
  ...extra,
});
beforeAll(async () => {
  const data = await setupManagement();
  [branchA, branchB] = data.branches as [string, string];
  admin = await login();
  unitId = (await get('/catalog/lookups')).body.units[0].id;
}, 30000);
afterAll(async () => {
  await Promise.all([pool.end(), migration.end()]);
});
describe('authentication and authorization', () => {
  it('bootstraps once, hashes passwords and stores only session digests', async () => {
    await expect(
      bootstrapAdministrator(migration, {
        username: 'another',
        displayName: 'Another',
        password: testPassword,
      }),
    ).rejects.toThrow('already complete');
    const hash = (
      await pool.query('SELECT password_hash FROM users WHERE id=$1', [
        admin.id,
      ])
    ).rows[0].password_hash as string;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(testPassword);
    const session = (
      await pool.query(
        'SELECT token_hash FROM user_sessions WHERE token_hash=$1',
        [digest(admin.cookie.split('=')[1]!)],
      )
    ).rows[0];
    expect(session).toBeDefined();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: 'test.admin', password: testPassword });
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(res.headers['set-cookie']?.[0]).toContain('SameSite=Strict');
  });
  it('rejects insecure production access, foreign origins and missing CSRF', async () => {
    const secure = createApp({
      ready: async () => true,
      logger: pino({ level: 'silent' }),
      database: {
        pool,
        auth: { origin: 'https://pos.test', insecureLoopback: false },
      },
    });
    expect(
      (
        await request(secure)
          .post('/api/v1/auth/login')
          .set('Origin', 'https://pos.test')
          .send({ username: 'test.admin', password: testPassword })
      ).status,
    ).toBe(403);
    const res = await request(secure)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://pos.test')
      .send({ username: 'test.admin', password: testPassword });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toContain('__Host-jce_session=');
    expect(res.headers['set-cookie']?.[0]).toContain('Secure');
    expect(
      (
        await request(app)
          .post('/api/v1/auth/lock')
          .set('Cookie', admin.cookie)
          .set('Origin', 'https://foreign.test')
          .set('X-CSRF-Token', admin.csrf)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/lock')
          .set('Cookie', admin.cookie)
          .set('Origin', origin)
      ).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/users')).status).toBe(401);
  });
  it('locks work, checks passwords, revokes logout and enforces idle/absolute expiry', async () => {
    const user = await makeUser('test.lock', 'cashier');
    expect((await post('/auth/lock', {}, user)).status).toBe(200);
    expect((await get(`/branches/${branchA}/catalog`, user)).status).toBe(423);
    expect(
      (await post('/auth/unlock', { password: 'incorrect' }, user)).status,
    ).toBe(401);
    expect(
      (await post('/auth/unlock', { password: testPassword }, user)).status,
    ).toBe(200);
    expect((await get(`/branches/${branchA}/catalog`, user)).status).toBe(200);
    const before = (
      await pool.query(
        'SELECT last_seen_at FROM user_sessions WHERE token_hash=$1',
        [digest(user.cookie.split('=')[1]!)],
      )
    ).rows[0].last_seen_at;
    await get('/auth/session', user);
    expect(
      (
        await pool.query(
          'SELECT last_seen_at FROM user_sessions WHERE token_hash=$1',
          [digest(user.cookie.split('=')[1]!)],
        )
      ).rows[0].last_seen_at,
    ).toEqual(before);
    await post('/auth/logout', {}, user);
    expect((await get('/auth/session', user)).status).toBe(401);
    const idle = await login('test.lock');
    await migration.query(
      "UPDATE user_sessions SET last_seen_at=now()-interval '31 minutes' WHERE token_hash=$1",
      [digest(idle.cookie.split('=')[1]!)],
    );
    expect((await get('/auth/session', idle)).status).toBe(401);
    const expired = await login('test.lock');
    await migration.query(
      "UPDATE user_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",
      [digest(expired.cookie.split('=')[1]!)],
    );
    expect((await get('/auth/session', expired)).status).toBe(401);
  });
  it('denies branch access, nested IDs, exports and privilege escalation', async () => {
    const manager = await makeUser('test.manager', 'manager');
    const customer = (
      await post(`/branches/${branchB}/customers`, {
        name: 'Other branch',
        contact: 'private',
      })
    ).body.id;
    for (const path of [
      `/branches/${branchB}/catalog`,
      `/branches/${branchB}/customers`,
      `/branches/${branchB}/customers/export`,
      `/branches/${branchB}/settings`,
      `/branches/${branchB}/imports/${randomUUID()}`,
    ])
      expect((await get(path, manager)).status, path).toBe(403);
    expect(
      (await get(`/branches/${branchA}/customers/${customer}`, manager)).status,
    ).toBe(404);
    expect(
      (await get(`/branches/${branchA}/customers/${customer}/history`, manager))
        .status,
    ).toBe(404);
    for (const data of [
      { roles: ['admin'], branchIds: [branchA] },
      { roles: ['cashier'], branchIds: [branchB] },
    ])
      expect(
        (
          await post(
            '/users',
            {
              username: 'test.escalate',
              displayName: 'Escalate',
              password: testPassword,
              ...data,
            },
            manager,
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await put(
          '/roles/cashier',
          { permissions: ['settings.global'], version: 1 },
          manager,
        )
      ).status,
    ).toBe(403);
    expect(
      (await post('/auth/branch', { branchId: branchB }, manager)).status,
    ).toBe(403);
    expect((await post('/auth/branch', { branchId: branchB })).status).toBe(
      200,
    );
    expect((await get('/auth/session')).body.branchId).toBe(branchB);
    const cashier = await makeUser('test.cashier', 'cashier');
    expect(
      (await post('/catalog/variants', variant('NO-RIGHTS'), cashier)).status,
    ).toBe(403);
    const local = (
      await post(`/branches/${branchA}/customers`, {
        name: 'Local customer',
        contact: 'hidden-contact',
      })
    ).body.id;
    expect(
      (await get(`/branches/${branchA}/customers/${local}`, cashier)).text,
    ).not.toContain('hidden-contact');
    expect(
      (await get(`/branches/${branchA}/customers/export`, cashier)).text,
    ).not.toContain('hidden-contact');
    const inventory = await makeUser('test.inventory', 'inventory');
    expect(
      (
        await put(
          `/branches/${branchA}/customers/${local}`,
          { name: 'Updated', contact: '', archived: false, version: 1 },
          inventory,
        )
      ).status,
    ).toBe(200);
    expect(
      (await get(`/branches/${branchA}/customers/${local}`)).body.contact,
    ).toBe('hidden-contact');
  });
  it('protects the last admin, revokes disabled or reassigned users, and forces password changes', async () => {
    expect(
      (
        await put(`/users/${admin.id}`, {
          username: 'test.admin',
          displayName: 'Synthetic administrator',
          roles: ['cashier'],
          branchIds: [branchA],
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect((await get('/auth/session')).status).toBe(200);
    const user = await makeUser('test.disable', 'cashier');
    expect(
      (
        await put(`/users/${user.id}`, {
          username: 'test.disable',
          displayName: 'Disable',
          roles: ['cashier'],
          branchIds: [branchA],
          disabled: true,
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect((await get('/auth/session', user)).status).toBe(401);
    const moved = await makeUser('test.move', 'cashier');
    expect(
      (
        await put(`/users/${moved.id}`, {
          username: 'test.move',
          displayName: 'Move',
          roles: ['cashier'],
          branchIds: [branchB],
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect((await get('/auth/session', moved)).status).toBe(401);
    const reset = await makeUser('test.reset', 'cashier');
    expect(
      (
        await post(`/users/${reset.id}/reset`, {
          password: 'Temporary-password-2026!',
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect((await get('/auth/session', reset)).status).toBe(401);
    const changed = await login('test.reset', 'Temporary-password-2026!');
    expect(
      (await get(`/branches/${branchA}/catalog`, changed)).body.error.code,
    ).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(
      (
        await post(
          '/auth/password',
          {
            currentPassword: 'Temporary-password-2026!',
            password: 'Changed-password-2026!',
          },
          changed,
        )
      ).status,
    ).toBe(200);
    expect((await get('/auth/session', changed)).status).toBe(401);
    await login('test.reset', 'Changed-password-2026!');
  });
  it('throttles repeated failures with persistent login history', async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await request(app)
            .post('/api/v1/auth/login')
            .set('Origin', origin)
            .send({ username: 'unknown.user', password: 'invalid' })
        ).status,
      ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .set('Origin', origin)
          .send({ username: 'unknown.user', password: 'invalid' })
      ).status,
    ).toBe(429);
    expect(
      (await get('/login-history')).body.some(
        (r: { success: boolean }) => !r.success,
      ),
    ).toBe(true);
  });
});
describe('master data and staged imports', () => {
  it('applies role permission revocation immediately to an existing session', async () => {
    const cashier = await login('test.cashier');
    const role = (await get('/roles')).body.find(
      (r: { code: string }) => r.code === 'cashier',
    ) as { version: number; permissions: string[] };
    expect((await get(`/branches/${branchA}/catalog`, cashier)).status).toBe(
      200,
    );
    expect(
      (
        await put('/roles/cashier', {
          version: role.version,
          permissions: role.permissions.filter((p) => p !== 'catalog.read'),
        })
      ).status,
    ).toBe(200);
    expect((await get(`/branches/${branchA}/catalog`, cashier)).status).toBe(
      403,
    );
    expect(
      (
        await put('/roles/cashier', {
          version: role.version + 1,
          permissions: role.permissions,
        })
      ).status,
    ).toBe(200);
  });
  it('keeps tax definitions and business configuration versioned without assuming a tax status', async () => {
    expect((await get('/settings/business')).body.value).toEqual({});
    const body = {
      name: 'Synthetic business',
      address: 'Test address only',
      currency: 'PHP',
      timezone: 'Asia/Manila',
      receiptFooter: '',
      receiptSeries: 'TEST',
      taxConfirmed: false,
      version: 1,
    };
    expect((await put('/settings/business', body)).status).toBe(200);
    expect(
      (await get('/settings/business/history')).body[0].value.taxConfirmed,
    ).toBe(false);
    const tax = await post('/catalog/taxes', {
      code: 'SYNTHETIC',
      name: 'Synthetic test rate',
      rate: '0.07',
      inclusive: true,
    });
    expect(tax.status, tax.text).toBe(200);
    expect(
      (
        await put(`/catalog/taxes/${tax.body.id}`, {
          code: 'SYNTHETIC',
          name: 'Synthetic test rate',
          rate: '0.08',
          inclusive: false,
          archived: false,
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (await get(`/catalog/taxes/${tax.body.id}/history`)).body.map(
        (r: { value: { rate: string } }) => r.value.rate,
      ),
    ).toEqual(['0.08', '0.07']);
    await expect(
      migration.query('DELETE FROM tax_code_history WHERE tax_id=$1', [
        tax.body.id,
      ]),
    ).rejects.toThrow();
  });
  it('supports barcodes, variant groups, optimistic edits, exact prices and immutable history', async () => {
    const created = await post(
      '/catalog/variants',
      variant('CAT-ONE', { barcodes: ['123456'] }),
    );
    expect(created.status, created.text).toBe(200);
    const id = created.body.id;
    expect(
      (
        await post(
          '/catalog/variants',
          variant('CAT-TWO', { barcodes: ['123456'] }),
        )
      ).status,
    ).toBe(409);
    expect((await post('/catalog/variants', variant('123456'))).status).toBe(
      409,
    );
    expect(
      (
        await post(
          '/catalog/variants',
          variant('CAT-FRACTION', { fractional: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await get(`/branches/${branchA}/catalog?q=123456`)).body.items[0].id,
    ).toBe(id);
    expect(
      (await get(`/branches/${branchA}/catalog?limit=100000`)).status,
    ).toBe(400);
    expect(
      (
        await get(
          `/branches/${branchA}/catalog?q=${encodeURIComponent("'; DROP TABLE users; --")}`,
        )
      ).body.items,
    ).toEqual([]);
    expect(
      (
        await put(`/branches/${branchA}/prices/${id}`, {
          amount: '1234567890.25',
          version: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put(`/branches/${branchA}/prices/${id}`, {
          amount: '99.99',
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put(`/branches/${branchA}/prices/${id}`, {
          amount: '1.00',
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await get(`/branches/${branchB}/catalog/${id}`)).body.price,
    ).toBeNull();
    const history = (await get(`/branches/${branchA}/prices/${id}/history`))
      .body;
    expect(history.map((r: { amount: string }) => r.amount)).toEqual([
      '99.99',
      '1234567890.25',
    ]);
    await expect(
      migration.query(
        'UPDATE product_price_history SET amount=0 WHERE variant_id=$1',
        [id],
      ),
    ).rejects.toThrow();
    const update = variant('CAT-ONE', {
      productId: created.body.productId,
      productVersion: 1,
      version: 1,
      archived: true,
      barcodes: ['123456'],
    });
    expect((await put(`/catalog/variants/${id}`, update)).status).toBe(200);
    expect((await put(`/catalog/variants/${id}`, update)).status).toBe(409);
    expect(
      (await get(`/branches/${branchA}/catalog?q=CAT-ONE`)).body.items,
    ).toHaveLength(0);
    expect(
      (
        await put(`/catalog/variants/${id}`, {
          ...update,
          productVersion: 2,
          version: 2,
          archived: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          '/catalog/variants',
          variant('CAT-SIBLING', {
            productId: created.body.productId,
            productVersion: 3,
          }),
        )
      ).status,
    ).toBe(200);
  });
  it('records scoped settings and rejects cross-branch register references', async () => {
    const settings = {
      tenders: ['cash', 'ewallet'],
      discountThreshold: '0.00',
      printerName: 'Synthetic printer',
      paperWidth: '80',
      version: 1,
    };
    expect((await put(`/branches/${branchA}/settings`, settings)).status).toBe(
      200,
    );
    expect((await put(`/branches/${branchA}/settings`, settings)).status).toBe(
      409,
    );
    expect(
      (await get(`/branches/${branchA}/settings/history`)).body,
    ).toHaveLength(1);
    expect((await get(`/branches/${branchB}/settings`)).body.value).toEqual({});
    const terminal = (
      await post(`/branches/${branchB}/terminals`, { code: 'TEST_TILL' })
    ).body.id;
    expect(
      (
        await post(`/branches/${branchA}/registers`, {
          code: 'REG_A',
          terminalId: terminal,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(`/branches/${branchB}/registers`, {
          code: 'REG_B',
          terminalId: terminal,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put(`/branches/${branchB}`, {
          code: 'DEMO_B',
          name: 'Synthetic B archived',
          archived: true,
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect((await get(`/branches/${branchB}/catalog`)).status).toBe(403);
    expect(
      (
        await put(`/branches/${branchB}`, {
          code: 'DEMO_B',
          name: 'Synthetic branch B',
          archived: false,
          version: 2,
        })
      ).status,
    ).toBe(200);
  });
  it('previews errors, commits once under concurrency, revalidates and rolls back failed imports', async () => {
    const header =
      'sku,product_name,variant_name,unit,conversion,fractional,minimum_stock,barcode,price\n';
    const bad = await post(`/branches/${branchA}/imports`, {
      csv: header + 'BAD,Thing,One,Missing,1,false,0,,1',
      duplicatePolicy: 'reject',
    });
    expect(bad.status).toBe(200);
    expect(bad.body.errors.length).toBeGreaterThan(0);
    expect(
      (await post(`/branches/${branchA}/imports/${bad.body.id}/commit`)).status,
    ).toBe(409);
    const csv =
      header +
      'IMP-ONE,Imported notebook,Plain,Piece,1,false,0,990000000123,10.50\nIMP-TWO,Imported pen,Blue,Piece,1,false,0,,20.25';
    const staged = await post(`/branches/${branchA}/imports`, {
      csv,
      duplicatePolicy: 'reject',
    });
    expect(staged.body.errors).toEqual([]);
    expect(
      (await get(`/branches/${branchA}/catalog?q=IMP-`)).body.items,
    ).toHaveLength(0);
    const results = await Promise.all([
      post(`/branches/${branchA}/imports/${staged.body.id}/commit`),
      post(`/branches/${branchA}/imports/${staged.body.id}/commit`),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(results[0]!.body.imported).toBe(2);
    const repeat = await post(`/branches/${branchA}/imports`, {
      csv,
      duplicatePolicy: 'skip',
    });
    expect(repeat.body.rows.every((r: { skip: boolean }) => r.skip)).toBe(true);
    expect(
      (await post(`/branches/${branchA}/imports/${repeat.body.id}/commit`)).body
        .imported,
    ).toBe(0);
    const race = await post(`/branches/${branchA}/imports`, {
      csv: header + 'IMP-RACE,Race,One,Piece,1,false,0,,1',
      duplicatePolicy: 'reject',
    });
    await post('/catalog/variants', variant('IMP-RACE'));
    expect(
      (await post(`/branches/${branchA}/imports/${race.body.id}/commit`))
        .status,
    ).toBe(409);
    const failure = await post(`/branches/${branchA}/imports`, {
      csv: header + 'IMP-ROLLBACK,Rollback,One,Piece,1,false,0,,1',
      duplicatePolicy: 'reject',
    });
    await migration.query(
      "CREATE FUNCTION public.test_reject_price() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER test_reject_price BEFORE INSERT ON product_prices FOR EACH ROW EXECUTE FUNCTION public.test_reject_price()",
    );
    try {
      expect(
        (await post(`/branches/${branchA}/imports/${failure.body.id}/commit`))
          .status,
      ).toBe(500);
      expect(
        (await get(`/branches/${branchA}/catalog?q=IMP-ROLLBACK`)).body.items,
      ).toHaveLength(0);
      expect(
        (
          await pool.query('SELECT result FROM catalog_imports WHERE id=$1', [
            failure.body.id,
          ])
        ).rows[0].result,
      ).toBeNull();
    } finally {
      await migration.query(
        'DROP TRIGGER test_reject_price ON product_prices; DROP FUNCTION public.test_reject_price()',
      );
    }
    expect(
      (await post(`/branches/${branchA}/imports/${failure.body.id}/commit`))
        .body.imported,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_logs WHERE action='import.changed'",
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
  });
  it('escapes dangerous CSV fields and retains archived customer history', async () => {
    const created = await post(`/branches/${branchA}/customers`, {
      name: '=1+1',
      contact: '@unsafe',
    });
    const id = created.body.id;
    expect(created.status).toBe(200);
    const exported = await get(`/branches/${branchA}/customers/export`);
    expect(exported.text).toContain('"\'=1+1"');
    expect(exported.text).toContain('"\'@unsafe"');
    expect(
      (
        await put(`/branches/${branchA}/customers/${id}`, {
          name: '=1+1',
          contact: '@unsafe',
          archived: true,
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (await get(`/branches/${branchA}/customers/${id}/history`)).body,
    ).toEqual([]);
    expect(
      (await pool.query('SELECT * FROM customer_transactions')).rowCount,
    ).toBe(0);
    const audit = (await pool.query('SELECT * FROM audit_logs')).rows;
    expect(JSON.stringify(audit)).not.toContain('@unsafe');
    expect(
      JSON.stringify((await pool.query('SELECT payload FROM sync_queue')).rows),
    ).not.toContain(testPassword);
  });
});
