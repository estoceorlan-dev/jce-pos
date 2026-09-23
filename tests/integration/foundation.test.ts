import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import request from 'supertest';
import { SCHEMA_VERSION } from '@jce/shared';
import { createApp } from '../../backend/src/app.js';
import { createPool } from '../../backend/src/db/pool.js';
import {
  migrate,
  isReady,
  migrationFiles,
} from '../../backend/src/db/migrations.js';
import {
  assertDatabaseRole,
  provisionDatabase,
  quoteIdentifier,
} from '../../backend/src/db/security.js';
import {
  initializeInstallation,
  registerBranch,
  registerTerminal,
} from '../../backend/src/db/identity.js';
import { withTransaction } from '../../backend/src/db/transaction.js';
import { idempotent } from '../../backend/src/db/idempotency.js';
import { allocateDocumentNumber } from '../../backend/src/db/numbering.js';
import { appendAudit } from '../../backend/src/audit/append.js';
import { appendOutbox } from '../../backend/src/sync/outbox.js';
import { checksum } from '../../backend/src/db/canonical.js';
import { storageSnapshot } from '../../backend/src/jobs/storage.js';
import { resetTestDatabase, testDatabase } from '../support/database.js';

const config = testDatabase();
const admin = createPool(config.adminUrl);
const migrator = createPool(config.connection('migrator'));
const runtime = createPool(config.connection('runtime'));
const backup = createPool(config.connection('backup'));
let installationId: string;
let branchId: string;
let terminalId: string;
beforeAll(async () => {
  await resetTestDatabase();
}, 30000);
afterAll(async () => {
  await Promise.all([admin.end(), migrator.end(), runtime.end(), backup.end()]);
});

describe('database provisioning and upgrade', () => {
  it('uses restricted separate roles and refuses repeated provisioning', async () => {
    await assertDatabaseRole(runtime, 'runtime');
    await assertDatabaseRole(migrator, 'migration');
    await expect(assertDatabaseRole(admin, 'runtime')).rejects.toThrow();
    await expect(assertDatabaseRole(backup, 'runtime')).rejects.toThrow();
    await expect(
      provisionDatabase(admin, config.credentials),
    ).rejects.toThrow();
    expect(await isReady(runtime)).toBe(false);
  });
  it('upgrades schema 1 without altering its checksum or applied timestamp', async () => {
    await migrate(migrator, { targetVersion: 1 });
    const previous = (await migrator.query('SELECT * FROM schema_migrations'))
      .rows;
    expect(await isReady(migrator)).toBe(false);
    // Failure halfway through migration 2 must roll back all its DDL and history.
    await migrator.query(
      'CREATE TABLE public.terminals (test_conflict integer)',
    );
    await expect(migrate(migrator)).rejects.toMatchObject({ code: '42P07' });
    expect(
      (
        await migrator.query(
          "SELECT to_regclass('public.installations') AS name",
        )
      ).rows[0]!.name,
    ).toBeNull();
    expect(
      (await migrator.query('SELECT * FROM schema_migrations')).rows,
    ).toEqual(previous);
    await migrator.query('DROP TABLE public.terminals');
    await Promise.all([migrate(migrator), migrate(migrator)]);
    await migrate(migrator);
    expect(
      (await migrator.query('SELECT * FROM schema_migrations WHERE version=1'))
        .rows,
    ).toEqual(previous);
    expect(
      (await migrator.query('SELECT * FROM schema_migrations')).rowCount,
    ).toBe(SCHEMA_VERSION);
    expect(await isReady(runtime)).toBe(true);
    const app = createApp({
      ready: () => isReady(runtime),
      logger: pino({ level: 'silent' }),
    });
    expect((await request(app).get('/health/ready')).status).toBe(200);
    await expect(migrate(runtime)).rejects.toThrow();
    await expect(migrate(migrator, { targetVersion: 1 })).rejects.toThrow(
      'downgrade',
    );
  });
  it('rejects altered checksums and a newer application schema', async () => {
    const files = await migrationFiles();
    await migrator.query(
      "UPDATE schema_migrations SET checksum='modified' WHERE version=1",
    );
    expect(await isReady(runtime)).toBe(false);
    await expect(migrate(migrator)).rejects.toThrow('incompatible');
    await migrator.query(
      'UPDATE schema_migrations SET checksum=$1 WHERE version=1',
      [files[0]!.checksum],
    );
    await migrator.query(
      "INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,'future','future')",
      [SCHEMA_VERSION + 1],
    );
    expect(await isReady(runtime)).toBe(false);
    await expect(migrate(migrator)).rejects.toThrow('incompatible');
    await migrator.query('DELETE FROM schema_migrations WHERE version=$1', [
      SCHEMA_VERSION + 1,
    ]);
    expect(await isReady(runtime)).toBe(true);
  });
  it('initializes one stable installation and scoped branch/terminal identities', async () => {
    const ids = await Promise.all([
      initializeInstallation(migrator),
      initializeInstallation(migrator),
    ]);
    installationId = ids[0]!;
    expect(ids[1]).toBe(installationId);
    expect((await runtime.query('SELECT * FROM installations')).rowCount).toBe(
      1,
    );
    branchId = await withTransaction(runtime, (tx) =>
      registerBranch(tx, {
        installationId,
        code: 'TEST_BRANCH',
        name: 'Synthetic test branch',
        actorId: null,
        requestId: randomUUID(),
      }),
    );
    terminalId = await withTransaction(runtime, (tx) =>
      registerTerminal(tx, {
        installationId,
        branchId,
        code: 'TILL_01',
        actorId: null,
        requestId: randomUUID(),
      }),
    );
    await expect(
      withTransaction(runtime, (tx) =>
        registerTerminal(tx, {
          installationId: randomUUID(),
          branchId,
          code: 'TILL_WRONG',
          actorId: null,
          requestId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTransaction(runtime, (tx) =>
        registerTerminal(tx, {
          installationId,
          branchId,
          code: 'TILL_01',
          actorId: null,
          requestId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      runtime.query('INSERT INTO installations(id) VALUES ($1)', [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('concurrency and immutable history', () => {
  it('rolls back a completed idempotency response when deferred constraints fail at commit', async () => {
    const orphan = randomUUID();
    const scope = {
      installationId,
      operation: 'test.deferred',
      key: randomUUID(),
    };
    await expect(
      idempotent(runtime, scope, {}, async (tx) => {
        await tx.query(
          'INSERT INTO branches (id,code,name) VALUES ($1,$2,$3)',
          [orphan, 'ORPHAN', 'Test without ownership'],
        );
        return { id: orphan };
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (await runtime.query('SELECT 1 FROM branches WHERE id=$1', [orphan]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await runtime.query(
          'SELECT 1 FROM idempotency_requests WHERE request_key=$1',
          [scope.key],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      await idempotent(runtime, scope, {}, async () => ({ retry: true })),
    ).toEqual({ retry: true });
  });
  it('returns one original result across simultaneous identical retries', async () => {
    const scope = {
      installationId,
      operation: 'branch.create',
      key: randomUUID(),
    };
    let calls = 0;
    const invoke = () =>
      idempotent(
        runtime,
        scope,
        { branchCode: 'RETRY', actorId: null },
        async (tx) => {
          calls++;
          const id = await registerBranch(tx, {
            installationId,
            code: 'RETRY',
            name: 'Retry fixture',
            actorId: null,
            requestId: scope.key,
          });
          return { id, total: '0.00' };
        },
      );
    const responses = await Promise.all(Array.from({ length: 8 }, invoke));
    expect(calls).toBe(1);
    expect(responses.every((r) => r.id === responses[0]!.id)).toBe(true);
    await expect(
      idempotent(
        runtime,
        scope,
        { branchCode: 'OTHER', actorId: null },
        async () => ({ id: 'never' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const reopened = createPool(config.connection('runtime'));
    try {
      expect(
        await idempotent(
          reopened,
          scope,
          { actorId: null, branchCode: 'RETRY' },
          async () => {
            throw new Error('must not rerun');
          },
        ),
      ).toEqual(responses[0]);
    } finally {
      await reopened.end();
    }
    expect(
      await idempotent(
        runtime,
        { ...scope, operation: 'different.operation' },
        {},
        async () => ({ distinct: true }),
      ),
    ).toEqual({ distinct: true });
  });
  it('rolls back an incomplete claim, then permits a successful retry', async () => {
    const key = randomUUID();
    await expect(
      withTransaction(runtime, async (tx) => {
        await tx.query(
          'INSERT INTO idempotency_requests(installation_id,operation,request_key,request_hash) VALUES ($1,$2,$3,$4)',
          [installationId, 'incomplete.test', key, 'a'.repeat(64)],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await runtime.query(
          'SELECT 1 FROM idempotency_requests WHERE request_key=$1',
          [key],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      await idempotent(
        runtime,
        { installationId, operation: 'incomplete.test', key },
        {},
        async () => ({ done: true }),
      ),
    ).toEqual({ done: true });
  });
  it('serializes document numbers and preserves committed numbering on reconnect', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () =>
        withTransaction(runtime, (tx) =>
          allocateDocumentNumber(tx, {
            documentId: randomUUID(),
            installationId,
            branchId,
            series: 'TEST',
          }),
        ),
      ),
    );
    expect(numbers.map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    const other = createPool(config.connection('runtime'));
    try {
      expect(
        await withTransaction(other, (tx) =>
          allocateDocumentNumber(tx, {
            documentId: randomUUID(),
            installationId,
            branchId,
            series: 'TEST',
          }),
        ),
      ).toBe('13');
    } finally {
      await other.end();
    }
    await expect(
      runtime.query(
        "UPDATE document_sequences SET last_number=1 WHERE series='TEST'",
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('denies ordinary updates, deletes, truncation, DDL and transport changes', async () => {
    for (const table of [
      'audit_logs',
      'document_numbers',
      'installations',
      'branch_ownership',
      'terminals',
      'sync_queue',
    ]) {
      await expect(runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject(
        { code: '42501' },
      );
      await expect(
        runtime.query(`TRUNCATE ${table} CASCADE`),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      runtime.query("UPDATE audit_logs SET action='tamper'"),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query("UPDATE sync_queue SET payload='{}'::jsonb"),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query(
        "UPDATE sync_queue SET status='acknowledged',acknowledged_at=now()",
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query('CREATE TABLE public.runtime_escape(id integer)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      backup.query("UPDATE branches SET name='tamper'"),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      migrator.query("UPDATE audit_logs SET action='tamper'"),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      migrator.query("UPDATE sync_queue SET payload='{}'::jsonb"),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('records verifiable event envelopes and rejects arbitrary sensitive payloads', async () => {
    const events = await runtime.query('SELECT * FROM sync_queue');
    for (const row of events.rows) {
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.checksum).toBe(
        checksum({
          eventId: row.event_id,
          installationId: row.installation_id,
          branchId: row.branch_id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          aggregateVersion: row.aggregate_version,
          schemaVersion: row.schema_version,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: row.occurred_at.toISOString(),
        }),
      );
    }
    await expect(
      withTransaction(runtime, (tx) =>
        appendOutbox(
          tx,
          {
            installationId,
            branchId,
            aggregateId: branchId,
            aggregateVersion: 100,
          },
          {
            eventType: 'branch.created',
            aggregateType: 'branch',
            payload: { branchId, password: 'secret' },
          } as never,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTransaction(runtime, (tx) =>
        appendAudit(tx, {
          installationId,
          branchId,
          actorId: null,
          requestId: randomUUID(),
          action: 'test',
          entityType: 'branch',
          entityId: branchId,
          entityVersion: 1,
          password: 'secret',
        } as never),
      ),
    ).rejects.toThrow();
  });
});

// Deliberately test-only domain tables: L2 proves shared atomicity; L5/L7
// implement real inventory and sales with approved business calculations.
describe('transaction rollback and retry with PostgreSQL fixture ledgers', () => {
  beforeAll(async () => {
    await migrator.query(`CREATE TABLE public.test_balance(id integer PRIMARY KEY, quantity numeric NOT NULL CHECK(quantity>=0));
      INSERT INTO public.test_balance VALUES(1,1);
      CREATE TABLE public.test_sales(id uuid PRIMARY KEY, amount numeric NOT NULL);
      CREATE TABLE public.test_payments(id uuid PRIMARY KEY REFERENCES public.test_sales(id), amount numeric NOT NULL);
      CREATE TABLE public.test_movements(id uuid PRIMARY KEY REFERENCES public.test_sales(id), quantity numeric NOT NULL);
      CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON public.test_movements FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
      GRANT SELECT,INSERT ON public.test_sales,public.test_payments,public.test_movements TO ${quoteIdentifier(config.credentials.runtime.name)};
      GRANT SELECT,UPDATE ON public.test_balance TO ${quoteIdentifier(config.credentials.runtime.name)};`);
  });
  it('does not report success when a callback swallows an SQL failure', async () => {
    const id = randomUUID();
    await expect(
      withTransaction(runtime, async (tx) => {
        await tx.query('INSERT INTO test_sales VALUES ($1,$2)', [id, '2.50']);
        try {
          await tx.query('SELECT 1 / 0');
        } catch {
          /* Simulate an incorrectly handled domain error. */
        }
        return { success: true };
      }),
    ).rejects.toThrow('did not commit');
    expect(
      (await runtime.query('SELECT 1 FROM test_sales WHERE id=$1', [id]))
        .rowCount,
    ).toBe(0);
  });
  it('leaves no partial effects after failures at every posting step', async () => {
    const baseline = (
      await runtime.query('SELECT count(*)::int AS n FROM audit_logs')
    ).rows[0]!.n;
    const baselineEvents = (
      await runtime.query('SELECT count(*)::int AS n FROM sync_queue')
    ).rows[0]!.n;
    for (let failAfter = 0; failAfter < 8; failAfter++) {
      const id = randomUUID();
      const scope = {
        installationId,
        operation: 'test.post',
        key: randomUUID(),
      };
      await expect(
        idempotent(runtime, scope, { id }, async (tx) => {
          let step = 0;
          const fail = () => {
            if (step++ === failAfter) throw new Error('injected');
          };
          fail(); // claim
          await tx.query('INSERT INTO test_sales VALUES ($1,$2)', [id, '2.50']);
          fail();
          await tx.query('INSERT INTO test_payments VALUES ($1,$2)', [
            id,
            '2.50',
          ]);
          fail();
          await tx.query('INSERT INTO test_movements VALUES ($1,$2)', [
            id,
            '-1',
          ]);
          fail();
          await tx.query(
            'UPDATE test_balance SET quantity=quantity-1 WHERE id=1',
          );
          fail();
          await allocateDocumentNumber(tx, {
            documentId: id,
            installationId,
            branchId,
            series: 'ROLLBACK',
          });
          fail();
          await appendAudit(tx, {
            installationId,
            branchId,
            actorId: null,
            requestId: scope.key,
            action: 'test.posted',
            entityType: 'test_sale',
            entityId: id,
            entityVersion: 1,
          });
          fail();
          await appendOutbox(
            tx,
            {
              installationId,
              branchId,
              aggregateId: branchId,
              aggregateVersion: 1000 + failAfter,
            },
            {
              eventType: 'branch.created',
              aggregateType: 'branch',
              payload: { branchId },
            },
          );
          fail();
          return { id };
        }),
      ).rejects.toThrow('injected');
      for (const table of ['test_sales', 'test_payments', 'test_movements'])
        expect(
          (await runtime.query(`SELECT count(*)::int AS n FROM ${table}`))
            .rows[0]!.n,
        ).toBe(0);
      expect(
        (await runtime.query('SELECT quantity FROM test_balance WHERE id=1'))
          .rows[0]!.quantity,
      ).toBe('1');
      expect(
        (
          await runtime.query(
            'SELECT 1 FROM idempotency_requests WHERE request_key=$1',
            [scope.key],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await runtime.query(
            "SELECT 1 FROM document_numbers WHERE series='ROLLBACK'",
          )
        ).rowCount,
      ).toBe(0);
    }
    expect(
      (await runtime.query('SELECT count(*)::int AS n FROM audit_logs'))
        .rows[0]!.n,
    ).toBe(baseline);
    expect(
      (await runtime.query('SELECT count(*)::int AS n FROM sync_queue'))
        .rows[0]!.n,
    ).toBe(baselineEvents);
  });
  it('allows only one transaction to claim the last fixture stock unit', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        withTransaction(runtime, async (tx) => {
          const stock = await tx.query(
            'UPDATE test_balance SET quantity=quantity-1 WHERE id=1 AND quantity>=1 RETURNING quantity',
          );
          if (!stock.rowCount) throw new Error('INSUFFICIENT_STOCK');
          return stock.rows[0]!.quantity;
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await runtime.query('SELECT quantity FROM test_balance')).rows[0]!
        .quantity,
    ).toBe('0');
  });
  it('retries a real serializable conflict with a bounded database-only callback', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let initialReads = 0;
    let calls = 0;
    const update = () => {
      let first = true;
      return withTransaction(
        runtime,
        async (tx) => {
          calls++;
          await tx.query('SELECT quantity FROM test_balance WHERE id=1');
          if (first) {
            first = false;
            initialReads++;
            if (initialReads === 2) release();
            await gate;
          }
          await tx.query(
            'UPDATE test_balance SET quantity=quantity+1 WHERE id=1',
          );
        },
        { isolation: 'serializable', retries: 2 },
      );
    };
    await Promise.all([update(), update()]);
    expect(calls).toBe(3);
    expect(
      (await runtime.query('SELECT quantity FROM test_balance')).rows[0]!
        .quantity,
    ).toBe('2');
    let attempts = 0;
    await expect(
      withTransaction(
        runtime,
        async () => {
          attempts++;
          throw Object.assign(new Error('retry limit'), { code: '40001' });
        },
        { retries: 2 },
      ),
    ).rejects.toThrow('retry limit');
    expect(attempts).toBe(3);
    attempts = 0;
    await expect(
      withTransaction(runtime, async () => {
        attempts++;
        throw Object.assign(new Error('unknown commit'), { code: '08006' });
      }),
    ).rejects.toThrow('unknown commit');
    expect(attempts).toBe(1);
  });
});

describe('local retention, backup and restore foundation', () => {
  it('adopts an administrator-owned L1 database without rewriting existing migration evidence', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const name = `jce_adopt_${suffix}_test`;
    const url = new URL(config.adminUrl);
    url.pathname = '/' + name;
    const legacyAdmin = createPool(url.toString());
    const credentials = {
      runtime: {
        name: `adopt_${suffix}_runtime`,
        password: 'legacy-test-runtime-only-2026',
      },
      migrator: {
        name: `adopt_${suffix}_migrator`,
        password: 'legacy-test-migrator-only-2026',
      },
      backup: {
        name: `adopt_${suffix}_backup`,
        password: 'legacy-test-backup-only-2026',
      },
    };
    const migratedUrl = new URL(url);
    migratedUrl.username = credentials.migrator.name;
    migratedUrl.password = credentials.migrator.password;
    const adopted = createPool(migratedUrl.toString());
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
      const first = (await migrationFiles())[0]!;
      await legacyAdmin.query(
        'CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      await legacyAdmin.query(
        'INSERT INTO schema_migrations(version,name,checksum) VALUES (1,$1,$2)',
        [first.name, first.checksum],
      );
      const prior = (await legacyAdmin.query('SELECT * FROM schema_migrations'))
        .rows;
      await provisionDatabase(legacyAdmin, credentials);
      await migrate(adopted);
      expect(
        (await adopted.query('SELECT * FROM schema_migrations WHERE version=1'))
          .rows,
      ).toEqual(prior);
      expect(await isReady(adopted)).toBe(true);
    } finally {
      await Promise.all([legacyAdmin.end(), adopted.end()]);
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`,
      );
      for (const role of Object.values(credentials))
        await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role.name)}`);
    }
  }, 30000);
  it('measures outbox growth and database/disk size without deleting events', async () => {
    const before = await storageSnapshot(
      runtime,
      process.cwd(),
      Number.MAX_SAFE_INTEGER,
    );
    expect(before.lowDisk).toBe(true);
    expect(BigInt(before.databaseBytes)).toBeGreaterThan(0n);
    expect(BigInt(before.outboxBytes)).toBeGreaterThan(0n);
    const withoutVolume = await storageSnapshot(runtime);
    expect(withoutVolume.freeBytes).toBeNull();
    expect(withoutVolume.pendingEvents).toBe(before.pendingEvents);
  });
  it('restores installation, terminals, event IDs, numbers and retry results from a read-only dump', async () => {
    // pg_dump/pg_restore 18 must be on PATH, or specify PG_BIN_DIR.
    const exec = promisify(execFile);
    const bin = (tool: string) =>
      process.env['PG_BIN_DIR']
        ? path.join(
            process.env['PG_BIN_DIR'],
            process.platform === 'win32' ? `${tool}.exe` : tool,
          )
        : tool;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jce-foundation-'));
    const databaseName = `jce_restore_${randomUUID().replaceAll('-', '')}_test`;
    const restoreUrl = new URL(config.adminUrl);
    restoreUrl.pathname = '/' + databaseName;
    const restored = createPool(restoreUrl.toString());
    const backupUrl = new URL(config.connection('backup'));
    const pgEnv = (url: URL) => ({
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
    });
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      await exec(
        bin('pg_dump'),
        ['--format=custom', '--file', path.join(dir, 'foundation.dump')],
        { env: pgEnv(backupUrl) },
      );
      await exec(
        bin('pg_restore'),
        [
          '--exit-on-error',
          '--dbname',
          databaseName,
          path.join(dir, 'foundation.dump'),
        ],
        { env: pgEnv(restoreUrl) },
      );
      expect(await isReady(restored)).toBe(true);
      expect(
        (await restored.query('SELECT id FROM installations')).rows[0]!.id,
      ).toBe(installationId);
      expect(
        (
          await restored.query('SELECT id FROM terminals WHERE id=$1', [
            terminalId,
          ])
        ).rowCount,
      ).toBe(1);
      for (const table of [
        'sync_queue',
        'audit_logs',
        'document_numbers',
        'idempotency_requests',
      ]) {
        const source = await admin.query(
          `SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text`,
        );
        expect(
          (
            await restored.query(
              `SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text`,
            )
          ).rows,
        ).toEqual(source.rows);
      }
    } finally {
      await restored.end();
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
