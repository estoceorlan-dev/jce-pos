import { createPool } from '../db/pool.js';
import { assertDatabaseRole } from '../db/security.js';
import { reconcile } from './ledger.js';
const pool = createPool(process.env['DATABASE_URL'] ?? '');
try {
  await assertDatabaseRole(pool, 'runtime');
  const rows = await reconcile(pool);
  const failures = rows.filter((r) => !r.matched);
  process.stdout.write(
    JSON.stringify(
      {
        checked: rows.length,
        matched: failures.length === 0,
        discrepancies: failures,
      },
      null,
      2,
    ) + '\n',
  );
  if (failures.length) process.exitCode = 2;
} catch {
  process.stderr.write(
    'Inventory reconciliation failed. Check database access and migrations.\n',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
