import { readDatabaseUrl } from './urls.js';
import { createPool } from './pool.js';
import { migrate } from './migrations.js';

try {
  const pool = createPool(readDatabaseUrl('MIGRATION_DATABASE_URL'));
  try {
    await migrate(pool);
    console.info('Database migrations are current.');
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'Migration failed. Check configuration, database access and migration compatibility.',
  );
  process.exitCode = 1;
}
