import { createPool } from './pool.js';
import { readDatabaseUrl } from './urls.js';
import { assertDatabaseRole } from './security.js';
import { seedDemo } from './demo.js';
try {
  if (process.env['DEMO_SEED_CONFIRM'] !== 'synthetic-empty-database')
    throw new Error('Explicit demo confirmation required.');
  const pool = createPool(readDatabaseUrl('MIGRATION_DATABASE_URL'));
  try {
    await assertDatabaseRole(pool, 'migration');
    await seedDemo(pool, {
      username: process.env['ADMIN_USERNAME'] ?? '',
      displayName: process.env['ADMIN_DISPLAY_NAME'] ?? '',
      password: process.env['ADMIN_PASSWORD'] ?? '',
    });
    console.info(
      'Synthetic demo created. Remove the supplied password from the local secret file.',
    );
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'Demo setup failed. Use a migrated, empty _demo database and explicitly supplied administrator credentials.',
  );
  process.exitCode = 1;
}
