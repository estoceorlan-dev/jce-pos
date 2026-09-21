import { createPool } from '../../backend/src/db/pool.js';
import { migrate } from '../../backend/src/db/migrations.js';
import { seedDemo } from '../../backend/src/db/demo.js';
import { resetTestDatabase } from './database.js';
export const testPassword = 'Synthetic-password-2026!';
export async function setupManagement() {
  const config = await resetTestDatabase();
  const pool = createPool(config.connection('migrator'));
  try {
    await migrate(pool);
    return await seedDemo(pool, {
      username: 'test.admin',
      displayName: 'Synthetic administrator',
      password: testPassword,
    });
  } finally {
    await pool.end();
  }
}
export default async function setup() {
  await setupManagement();
}
