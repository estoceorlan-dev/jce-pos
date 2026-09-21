import { createPool } from '../db/pool.js';
import { readConfig } from '../config.js';
import { storageSnapshot } from './storage.js';

try {
  const config = readConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    console.info(
      JSON.stringify(
        await storageSnapshot(
          pool,
          config.STORAGE_MONITOR_PATH,
          config.STORAGE_MIN_FREE_BYTES,
        ),
      ),
    );
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'Storage check failed. Check database readiness and the configured database-volume path.',
  );
  process.exitCode = 1;
}
