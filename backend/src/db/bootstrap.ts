import { createPool } from './pool.js';
import { assertDatabaseRole } from './security.js';
import { isReady } from './migrations.js';
import { initializeInstallation } from './identity.js';
import { readDatabaseUrl } from './urls.js';

try {
  const pool = createPool(readDatabaseUrl('MIGRATION_DATABASE_URL'));
  try {
    await assertDatabaseRole(pool, 'migration');
    if (!(await isReady(pool))) throw new Error('Migrations required.');
    await initializeInstallation(pool);
    console.info(
      'Installation identity is initialized. Repeating bootstrap preserves the same identity. User creation arrives in L3.',
    );
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'Bootstrap failed. Check the dedicated migration credential and apply compatible migrations first.',
  );
  process.exitCode = 1;
}
