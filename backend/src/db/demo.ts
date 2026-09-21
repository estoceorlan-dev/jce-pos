import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  bootstrapAdministrator,
  newSession,
  readSession,
} from '../auth/service.js';
import { initializeInstallation, registerBranch } from './identity.js';
import { withTransaction } from './transaction.js';
import { recordChange } from '../management/common.js';
import { saveVariant, savePrice } from '../management/catalog.js';
/** Explicit synthetic setup for an empty disposable demo/test database only. */
export async function seedDemo(
  pool: pg.Pool,
  input: { username: string; displayName: string; password: string },
) {
  const name = (
    await pool.query<{ name: string }>('SELECT current_database() AS name')
  ).rows[0]!.name;
  if (!/_(demo|test)$/.test(name))
    throw new Error('Demo setup requires a database ending in _demo or _test.');
  if (
    (
      await pool.query(
        'SELECT 1 FROM users UNION ALL SELECT 1 FROM branches LIMIT 1',
      )
    ).rowCount
  )
    throw new Error('Demo setup requires no existing users or branches.');
  const installationId = await initializeInstallation(pool);
  const branches = await withTransaction(pool, async (tx) => {
    const ids: string[] = [];
    for (const code of ['DEMO_A', 'DEMO_B'])
      ids.push(
        await registerBranch(tx, {
          installationId,
          code,
          name: `Synthetic branch ${code.slice(-1)}`,
          actorId: null,
          requestId: randomUUID(),
        }),
      );
    return ids;
  });
  const userId = await bootstrapAdministrator(pool, input);
  await withTransaction(pool, async (tx) => {
    const token = await newSession(tx, userId);
    const session = await readSession(tx, token);
    const unitId = randomUUID();
    await tx.query("INSERT INTO product_units(id,name) VALUES($1,'Piece')", [
      unitId,
    ]);
    await recordChange(tx, userId, null, 'unit', unitId, 1);
    const product = await saveVariant(
      { tx, session },
      {
        productName: 'Synthetic notebook',
        name: 'Plain',
        sku: 'DEMO-NOTE',
        unitId,
        conversion: '1',
        minimumStock: '5',
        fractional: false,
        categoryId: null,
        brandId: null,
        taxCodeId: null,
        barcodes: ['990000000001'],
        archived: false,
      },
    );
    await savePrice(
      { tx, session, branchId: branches[0]! },
      product.id,
      '25.00',
      0,
    );
    await savePrice(
      { tx, session, branchId: branches[1]! },
      product.id,
      '27.50',
      0,
    );
    await tx.query(
      'UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1',
      [session.hash],
    );
  });
  return { userId, branches };
}
