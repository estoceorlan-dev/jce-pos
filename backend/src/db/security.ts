import pg from 'pg';
import { z } from 'zod';

export const roleName = z.string().regex(/^[a-z][a-z0-9_]{2,50}$/);
const credential = z
  .object({
    name: roleName,
    password: z
      .string()
      .min(20)
      .max(200)
      .refine((s) => !s.includes('\0')),
  })
  .strict();
const provisionSchema = z
  .object({ runtime: credential, migrator: credential, backup: credential })
  .strict();
export type Credentials = z.infer<typeof provisionSchema>;
type Security = {
  runtime_role: string;
  migration_role: string;
  backup_role: string;
};
export const quoteIdentifier = (name: string) => pg.escapeIdentifier(name);

/** One-time administrator action on a dedicated empty or L1-only database. */
export async function provisionDatabase(pool: pg.Pool, input: Credentials) {
  const roles = provisionSchema.parse(input);
  const entries = Object.values(roles);
  if (
    new Set(entries.map((r) => r.name)).size !== 3 ||
    new Set(entries.map((r) => r.password)).size !== 3
  )
    throw new Error('Use three distinct roles and passwords.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74012001)');
    const admin = await client.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname=current_user',
    );
    if (!admin.rows[0]?.rolsuper)
      throw new Error(
        'One-time provisioning requires a database administrator.',
      );
    const tables = await client.query<{ relname: string }>(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')",
    );
    if (tables.rows.some((r) => r.relname !== 'schema_migrations'))
      throw new Error('Provision only an empty or L1-only dedicated database.');
    if (tables.rows.length) {
      const history = await client.query<{ version: number }>(
        'SELECT version FROM public.schema_migrations',
      );
      if (history.rows.some((r) => r.version !== 1))
        throw new Error('Only the L1 schema can be adopted.');
    }
    const existing = await client.query(
      'SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',
      [entries.map((r) => r.name)],
    );
    if (existing.rowCount)
      throw new Error(
        'Provisioning roles already exist; do not reuse or reset credentials.',
      );
    const database = (
      await client.query<{ name: string }>('SELECT current_database() AS name')
    ).rows[0]!.name;
    for (const entry of entries) {
      // PostgreSQL utility statements cannot bind role/password parameters.
      await client.query(
        `CREATE ROLE ${quoteIdentifier(entry.name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(entry.password)}`,
      );
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(entry.name)}`,
      );
      await client.query(
        `ALTER ROLE ${quoteIdentifier(entry.name)} IN DATABASE ${quoteIdentifier(database)} SET search_path = pg_catalog, public`,
      );
    }
    await client.query(
      `REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`,
    );
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query(
      `ALTER SCHEMA public OWNER TO ${quoteIdentifier(roles.migrator.name)}`,
    );
    await client.query(
      `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(roles.runtime.name)}, ${quoteIdentifier(roles.backup.name)}`,
    );
    if (tables.rows.length)
      await client.query(
        `ALTER TABLE public.schema_migrations OWNER TO ${quoteIdentifier(roles.migrator.name)}`,
      );
    await client.query(
      `SET LOCAL ROLE ${quoteIdentifier(roles.migrator.name)}`,
    );
    // pg_catalog first in search_path is safe for function resolution; all DDL
    // is explicitly placed in public during provisioning/migration.
    await client.query(
      'CREATE TABLE public.database_security (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), runtime_role name NOT NULL UNIQUE, migration_role name NOT NULL UNIQUE, backup_role name NOT NULL UNIQUE)',
    );
    await client.query(
      'INSERT INTO public.database_security (runtime_role,migration_role,backup_role) VALUES ($1,$2,$3)',
      [roles.runtime.name, roles.migrator.name, roles.backup.name],
    );
    await client.query(
      `GRANT SELECT ON public.database_security TO ${quoteIdentifier(roles.runtime.name)}, ${quoteIdentifier(roles.backup.name)}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdentifier(roles.backup.name)}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${quoteIdentifier(roles.backup.name)}`,
    );
    await client.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function securityRoles(
  client: pg.Pool | pg.PoolClient,
): Promise<Security> {
  const result = await client.query<Security>(
    'SELECT runtime_role, migration_role, backup_role FROM public.database_security WHERE singleton',
  );
  if (!result.rows[0]) throw new Error('Database provisioning is required.');
  return result.rows[0];
}

export async function assertDatabaseRole(
  client: pg.Pool | pg.PoolClient,
  kind: 'runtime' | 'migration',
) {
  const roles = await securityRoles(client);
  const expected =
    kind === 'runtime' ? roles.runtime_role : roles.migration_role;
  const result = await client.query<{
    name: string;
    elevated: boolean;
    owns_database: boolean;
  }>(`SELECT current_user AS name,
    (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS elevated,
    (d.datdba=r.oid) AS owns_database FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname=current_user AND d.datname=current_database()`);
  const row = result.rows[0];
  if (!row || row.name !== expected || row.elevated || row.owns_database)
    throw new Error(`A dedicated unprivileged ${kind} credential is required.`);
  const memberships = await client.query(
    'SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user',
  );
  if (memberships.rowCount)
    throw new Error('Database service roles must not inherit other roles.');
}

export async function grantFoundationAccess(client: pg.PoolClient) {
  const roles = await securityRoles(client);
  const runtime = quoteIdentifier(roles.runtime_role);
  const backup = quoteIdentifier(roles.backup_role);
  await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC');
  await client.query(
    'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC',
  );
  await client.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backup}`,
  );
  await client.query(
    `GRANT SELECT ON public.schema_migrations, public.installations, public.branches, public.branch_ownership, public.terminals, public.document_sequences, public.document_numbers, public.idempotency_requests, public.audit_logs, public.sync_queue TO ${runtime}`,
  );
  await client.query(
    `GRANT INSERT ON public.branches, public.branch_ownership, public.terminals, public.document_sequences, public.document_numbers, public.idempotency_requests, public.audit_logs, public.sync_queue TO ${runtime}`,
  );
  await client.query(
    `GRANT UPDATE (name, version, archived_at) ON public.branches TO ${runtime}`,
  );
  await client.query(
    `GRANT UPDATE (last_number) ON public.document_sequences TO ${runtime}`,
  );
  await client.query(
    `GRANT UPDATE (response, completed_at) ON public.idempotency_requests TO ${runtime}`,
  );
  // No runtime DELETE/TRUNCATE/DDL or outbox delivery permissions. Transport disabled.
}
