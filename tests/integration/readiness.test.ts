import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createPool } from '../../backend/src/db/pool.js';
import { isReady, migrate } from '../../backend/src/db/migrations.js';
import { createApp } from '../../backend/src/app.js';

const url = process.env['TEST_DATABASE_URL'];
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable database whose name ends in _test.',
  );
const pool = createPool(url);
beforeAll(async () => {
  await pool.query('DROP TABLE IF EXISTS schema_migrations');
});
afterAll(async () => {
  await pool.end();
});
describe('real PostgreSQL migration compatibility', () => {
  it('rejects an uninitialized database', async () => {
    expect(await isReady(pool)).toBe(false);
  });
  it('serializes concurrent migrations and remains repeatable', async () => {
    await Promise.all([migrate(pool), migrate(pool)]);
    await migrate(pool);
    expect(await isReady(pool)).toBe(true);
    expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(
      1,
    );
    const app = createApp({
      ready: () => isReady(pool),
      logger: pino({ level: 'silent' }),
    });
    expect((await request(app).get('/health/ready')).status).toBe(200);
  });
  it('rejects modified migration history', async () => {
    const original = await pool.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version = 1',
    );
    await pool.query(
      "UPDATE schema_migrations SET checksum = 'modified' WHERE version = 1",
    );
    expect(await isReady(pool)).toBe(false);
    await expect(migrate(pool)).rejects.toThrow('incompatible');
    await pool.query(
      'UPDATE schema_migrations SET checksum = $1 WHERE version = 1',
      [original.rows[0]!.checksum],
    );
  });
  it('rejects a database upgraded beyond this application', async () => {
    await pool.query(
      "INSERT INTO schema_migrations(version, name, checksum) VALUES (2, 'future', 'future')",
    );
    expect(await isReady(pool)).toBe(false);
    await expect(migrate(pool)).rejects.toThrow('incompatible');
    await pool.query('DELETE FROM schema_migrations WHERE version = 2');
    expect(await isReady(pool)).toBe(true);
  });
});
