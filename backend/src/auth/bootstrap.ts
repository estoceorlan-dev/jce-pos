import { bootstrapAdministrator } from './service.js';
import { createPool } from '../db/pool.js';
import { readDatabaseUrl } from '../db/urls.js';
import { assertDatabaseRole } from '../db/security.js';
try {
  const pool = createPool(readDatabaseUrl('MIGRATION_DATABASE_URL'));
  try {
    await assertDatabaseRole(pool, 'migration');
    await bootstrapAdministrator(pool, {
      username: process.env['ADMIN_USERNAME'],
      displayName: process.env['ADMIN_DISPLAY_NAME'],
      password: process.env['ADMIN_PASSWORD'],
    });
    console.info(
      'Administrator created. Remove ADMIN_PASSWORD from the local secret file.',
    );
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'Administrator bootstrap failed. Check installation setup, supplied credentials and whether an administrator already exists.',
  );
  process.exitCode = 1;
}
