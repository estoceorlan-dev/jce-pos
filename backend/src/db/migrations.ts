import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type pg from 'pg';
import { SCHEMA_VERSION } from '@jce/shared';
import { assertDatabaseRole, grantFoundationAccess } from './security.js';

const directory = new URL('../../migrations/', import.meta.url);
export async function migrationFiles() {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (
    names.length !== SCHEMA_VERSION ||
    names.some((name, index) => Number(name.slice(0, 4)) !== index + 1)
  )
    throw new Error(
      'Migration manifest must be contiguous and match SCHEMA_VERSION.',
    );
  return Promise.all(
    names.map(async (name) => {
      const sql = (await readFile(new URL(name, directory), 'utf8')).replace(
        /\r\n/g,
        '\n',
      );
      return {
        version: Number(name.slice(0, 4)),
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}
export async function isReady(pool: pg.Pool): Promise<boolean> {
  try {
    const files = await migrationFiles();
    const result = await pool.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    return (
      files.length === SCHEMA_VERSION &&
      result.rows.length === files.length &&
      files.every(
        (file, index) =>
          result.rows[index]?.version === file.version &&
          result.rows[index]?.checksum === file.checksum,
      )
    );
  } catch {
    return false;
  }
}
export async function migrate(
  pool: pg.Pool,
  options: { targetVersion?: number } = {},
) {
  const files = await migrationFiles();
  const target = options.targetVersion ?? SCHEMA_VERSION;
  if (!Number.isInteger(target) || target < 1 || target > SCHEMA_VERSION)
    throw new Error('Invalid migration target.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertDatabaseRole(client, 'migration');
    // Leaving pg_catalog implicit keeps built-ins first, while unqualified DDL
    // targets the migrator-owned public schema.
    await client.query('SET LOCAL search_path = public');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock(74012001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    if (
      applied.rows.some(
        (row, index) =>
          files[index]?.version !== row.version ||
          files[index]?.checksum !== row.checksum,
      )
    )
      throw new Error(
        'Migration history is incompatible; restore the matching application version.',
      );
    if (applied.rows.length > target)
      throw new Error('Migration downgrade is not supported.');
    for (const file of files.slice(applied.rows.length, target)) {
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [file.version, file.name, file.checksum],
      );
    }
    if (target >= 2) await grantFoundationAccess(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
