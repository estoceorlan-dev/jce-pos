import type pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

const active = new WeakSet<pg.PoolClient>();
export type Transaction = pg.PoolClient;
export function requireTransaction(client: Transaction) {
  if (!active.has(client))
    throw new Error('This helper requires withTransaction.');
}

/** Callback may run again. Database work only: no printing, HTTP or other side effects. */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (tx: Transaction) => Promise<T>,
  options: {
    retries?: number;
    isolation?: 'read committed' | 'serializable';
  } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5)
    throw new Error('Retries must be between zero and five.');
  const isolation = options.isolation ?? 'read committed';
  if (!['read committed', 'serializable'].includes(isolation))
    throw new Error('Invalid isolation.');
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      await client.query("SET LOCAL lock_timeout = '5s'");
      active.add(client);
      const result = await work(client);
      const completion = await client.query('COMMIT');
      // PostgreSQL returns ROLLBACK (without throwing) if a callback swallowed
      // an SQL error and left the transaction aborted. Never report success.
      if (completion.command !== 'COMMIT')
        throw new Error('Transaction was aborted and did not commit.');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      const code = (error as { code?: string }).code;
      // Never replay ambiguous connection/commit failures automatically.
      if (
        broken ||
        !['40001', '40P01'].includes(code ?? '') ||
        attempt >= retries
      )
        throw error;
    } finally {
      active.delete(client);
      client.release(broken);
    }
    await delay(10 * 2 ** attempt + Math.floor(Math.random() * 10));
  }
}
