import { createPool } from './pool.js';
import { provisionDatabase } from './security.js';
import { readDatabaseUrl } from './urls.js';

try {
  const pool = createPool(readDatabaseUrl('ADMIN_DATABASE_URL'));
  try {
    await provisionDatabase(pool, {
      runtime: {
        name: process.env['RUNTIME_DB_ROLE'] ?? 'jce_runtime',
        password: process.env['RUNTIME_DB_PASSWORD'] ?? '',
      },
      migrator: {
        name: process.env['MIGRATION_DB_ROLE'] ?? 'jce_migrator',
        password: process.env['MIGRATION_DB_PASSWORD'] ?? '',
      },
      backup: {
        name: process.env['BACKUP_DB_ROLE'] ?? 'jce_backup',
        password: process.env['BACKUP_DB_PASSWORD'] ?? '',
      },
    });
    console.info(
      'Database roles provisioned. Configure separate runtime, migration and backup connections.',
    );
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'Database provisioning failed. Use an administrator on a dedicated empty/L1 database, unused role names and distinct passwords of at least 20 characters.',
  );
  process.exitCode = 1;
}
