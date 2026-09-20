import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type pg from 'pg';
import { SCHEMA_VERSION } from '@jce/shared';

const directory = new URL('../../migrations/', import.meta.url);
export async function migrationFiles() {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
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
export async function migrate(pool: pg.Pool) {
  const files = await migrationFiles();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    for (const file of files.slice(applied.rows.length)) {
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [file.version, file.name, file.checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
