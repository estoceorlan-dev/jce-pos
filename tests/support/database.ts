import { createHash } from 'node:crypto';
import { createPool } from '../../backend/src/db/pool.js';
import {
  provisionDatabase,
  quoteIdentifier,
} from '../../backend/src/db/security.js';

export function testDatabase() {
  const raw = process.env['TEST_DATABASE_URL'];
  if (!raw || !new URL(raw).pathname.endsWith('_test'))
    throw new Error(
      'TEST_DATABASE_URL must identify a dedicated disposable database ending in _test. Its administrator must be able to create roles and databases.',
    );
  const url = new URL(raw);
  const suffix = createHash('sha256')
    .update(url.pathname)
    .digest('hex')
    .slice(0, 10);
  const credentials = {
    runtime: {
      name: `test_${suffix}_runtime`,
      password: 'test-only-runtime-credential-2026',
    },
    migrator: {
      name: `test_${suffix}_migrator`,
      password: 'test-only-migration-credential-2026',
    },
    backup: {
      name: `test_${suffix}_backup`,
      password: 'test-only-backup-credential-2026',
    },
  };
  function connection(role: keyof typeof credentials) {
    const copy = new URL(url);
    copy.username = credentials[role].name;
    copy.password = credentials[role].password;
    return copy.toString();
  }
  return { adminUrl: raw, credentials, connection };
}

/** Destructive by design, restricted to an explicitly supplied disposable test DB. */
export async function resetTestDatabase() {
  const config = testDatabase();
  const admin = createPool(config.adminUrl);
  try {
    await admin.query('DROP SCHEMA public CASCADE');
    await admin.query('CREATE SCHEMA public');
    for (const role of Object.values(config.credentials)) {
      const existing = await admin.query(
        'SELECT 1 FROM pg_roles WHERE rolname=$1',
        [role.name],
      );
      if (existing.rowCount) {
        await admin.query(`DROP OWNED BY ${quoteIdentifier(role.name)}`);
        await admin.query(`DROP ROLE ${quoteIdentifier(role.name)}`);
      }
    }
    await provisionDatabase(admin, config.credentials);
  } finally {
    await admin.end();
  }
  return config;
}
