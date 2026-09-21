# Database setup and L1 upgrade

Use Node 24.21.0/npm 11.19.0 and PostgreSQL 18. Commands run from the repository root after `npm ci` and `npm run build:server`. Use a **dedicated** application database. `db:provision` changes privileges on that database's `public` schema and revokes PUBLIC database access; never point it at a database shared with another application.

## Separate credentials

An operator first creates the database with a PostgreSQL administrator. Provide existing administrator credentials locally; this repository supplies no default production password. Choose three distinct passwords of at least 20 characters and unused role names. Names default to `jce_runtime`, `jce_migrator` and `jce_backup`; override them for multiple installations sharing a PostgreSQL cluster. Role names must contain lowercase ASCII letters/digits/underscore, begin with a letter, and be 3–51 characters.

Create `.local/provision.env` (ignored by Git):

```dotenv
ADMIN_DATABASE_URL=postgresql://administrator:URL_ENCODED_PASSWORD@127.0.0.1:5432/jce_pos
RUNTIME_DB_ROLE=jce_runtime
RUNTIME_DB_PASSWORD=REPLACE_WITH_UNIQUE_RUNTIME_PASSWORD
MIGRATION_DB_ROLE=jce_migrator
MIGRATION_DB_PASSWORD=REPLACE_WITH_UNIQUE_MIGRATION_PASSWORD
BACKUP_DB_ROLE=jce_backup
BACKUP_DB_PASSWORD=REPLACE_WITH_UNIQUE_BACKUP_PASSWORD
```

The sample values are placeholders, not usable store credentials. Quote values as required by dotenv syntax and percent-encode URL passwords. Store credentials in restricted files outside shared/cloud-synced locations; Git ignore is not a filesystem access control.

Run once:

```powershell
npm run db:provision
```

Provisioning is atomic. It refuses to reuse existing role names or run on a database containing anything beyond L1 migration metadata. An error rolls back newly created roles and grants; the command never resets an existing password. It requires a PostgreSQL superuser for this one-time role/ownership setup. Remove the administrator credential file after safely placing required credentials in their respective operator stores; the server does not read it.

Create `.local/migration.env` with only the migrator connection:

```dotenv
MIGRATION_DATABASE_URL=postgresql://jce_migrator:URL_ENCODED_MIGRATION_PASSWORD@127.0.0.1:5432/jce_pos
```

Create runtime `.env` from `.env.example` and set **only** `DATABASE_URL` to the runtime connection. Keep the backup connection separately as `.local/backup.env` or in the backup operator's credential store (`BACKUP_DATABASE_URL`); never pass it or migration/admin credentials to the server process.

```powershell
npm run db:migrate
npm run db:bootstrap
npm run start:server
```

Migrate uses only `MIGRATION_DATABASE_URL`, never a fallback to runtime credentials. Bootstrap initializes installation identity and its audit/outbox records; repeating it returns the same identity without duplicates. It does **not** create an administrator user or sample branches. L3 supplies user/account setup. A normal runtime process cannot create or replace the installation identity.

Open `http://127.0.0.1:3000`. Liveness is independent of database availability. Readiness requires the configured runtime role and exact migration compatibility. Configure `STORAGE_MONITOR_PATH` to an existing directory on the database volume for free-space alerts; the monitor does not assume that the application directory uses that disk.

## Upgrade from L1

Stop the application and take a verified backup before a real upgrade. Keep migration 0001 unchanged. For an L1-only database using an old shared/admin credential, run `db:provision` with new role names/passwords. Provisioning adopts the existing `schema_migrations` table under the migrator role while preserving its rows. Then run migrations and bootstrap with the dedicated migrator connection and restart with the new runtime connection.

Already provisioned L2 databases skip `db:provision`; `db:migrate` is repeatable and serializes migration attempts. Unknown versions, edited checksums, gaps/duplicate migration versions or downgrades fail. One transaction covers the migration batch and history rows. Do not repair a mismatch by editing recorded checksums. Restore the matching application/database pair or investigate with the maintainer.

## Read-only backups and restoration

PostgreSQL 18 `pg_dump`/`pg_restore` must be available (or set `PG_BIN_DIR` for tests). Use the backup role for logical dumps via a protected libpq password file or securely supplied environment. Do not put passwords in command arguments or public logs. Example with libpq connection variables already configured for the backup account:

```powershell
pg_dump --format=custom --file=backups/foundation.dump
```

This is a manual logical dump, not an encrypted off-device scheduled backup. The later operations release must provide that workflow and measured RPO/RTO. Backup directories are Git-ignored. A readable dump contains sensitive application data and must be protected appropriately.

A database dump does not create cluster roles. On a replacement cluster, establish the same role names with fresh credentials before restoring the dump as an administrator; restore owners/ACLs, then configure runtime/migrator/backup secrets separately. Do not restore on top of live data. Preserve the original installation identity when replacing the host; isolate any restored rehearsal clone so it cannot become a second writable source for that identity. Test restores compare IDs, outbox checksums, number allocations and idempotency history. Account/financial reconciliation and timed host recovery arrive with their later phases.

## Test setup

Use a disposable PostgreSQL cluster and administrator URL pointing to a database ending in `_test`. The suite **drops/recreates that database's public schema**, provisions synthetic restricted roles and creates/drops temporary `_test` databases for upgrade/restore checks. Do not use any development/store database you need to retain.

```powershell
$env:TEST_DATABASE_URL='postgresql://test_administrator:YOUR_TEST_PASSWORD@127.0.0.1:5432/jce_pos_test'
$env:PG_BIN_DIR='C:\Program Files\PostgreSQL\18\bin'
npx playwright install chromium
npm run verify:release
```

The suite leaves the dedicated test database migrated and initialized. Playwright derives its synthetic runtime credential from the test database name and never starts the server using the test administrator. Run the integration suite first when invoking browser tests alone. Synthetic test credentials are committed solely for isolated test infrastructure and must never be used for an installation.

CI installs PostgreSQL 18 client tools using the [official PostgreSQL Ubuntu repository](https://www.postgresql.org/download/linux/ubuntu/), then runs the same checks against its disposable service.
