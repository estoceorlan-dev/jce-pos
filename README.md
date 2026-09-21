# JCE POS

Business-specific answers and confirmations are stored only in `.local/business-intake/`, which Git ignores. This shared document contains generic planning guidance; consult the local records before applying defaults or requesting an already-recorded decision.

Point-of-sale and general merchandise management system for JCE Dry Goods Trading.

**L2 database foundation implemented.** The React/Express shell now has schema upgrades, separate database roles, transaction/idempotency/decimal/numbering helpers, installation identities, immutable audit records, a local outbox and storage monitoring. Private L0 confirmations remain local; unresolved business rules and fixture approval remain open. Login, checkout and the Windows installer arrive in later milestones.

## Start locally

Use Node **24.21.0**, npm **11.19.0** and PostgreSQL **18**. Create a dedicated empty development database (or adopt an L1-only database) and follow the [database setup runbook](docs/runbooks/database-foundation.md) to supply separate runtime, migrator and backup credentials. Then run from this directory:

```powershell
npm ci
Copy-Item .env.example .env
# Set runtime DATABASE_URL in .env and separate ignored provision/migration files.
npm run build:server
npm run db:provision
npm run db:migrate
npm run db:bootstrap
npm run start:server
```

Open **http://127.0.0.1:3000**. Express serves the built UI without Vite. `npm run dev` starts the development UI at port 5173. See the [development runbook](docs/runbooks/development.md) for configuration, script contracts and troubleshooting.

## Verify

```powershell
$env:TEST_DATABASE_URL='postgresql://jce_test:your_password@127.0.0.1:5432/jce_pos_test'
$env:PG_BIN_DIR='C:\Program Files\PostgreSQL\18\bin'
npx playwright install chromium
npm run verify:release
```

Tests require an administrator on a **dedicated disposable PostgreSQL cluster** and a database ending in `_test`. They recreate its public schema and create temporary roles/databases. PostgreSQL 18 client tools are needed for dump/restore verification. The pipeline covers formatting/lint, strict types, numerical and HTTP boundaries, PostgreSQL upgrades/concurrency/rollback/permissions/restore, and production browser journeys. It never uses real store data.

See [transactional decisions](docs/decisions/0004-transactional-foundation.md), [database setup](docs/runbooks/database-foundation.md), [storage/retention](docs/runbooks/storage-retention.md), [L2 verification](docs/acceptance/l2-verification.md), [L0 evidence checklist](docs/acceptance/l0-evidence-register.md) and [synthetic calculation fixtures](tests/fixtures/l0-money-stock.json).

## Project documents

| Document                                                       | Purpose                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Architecture](ARCHITECTURE.md)                                | System scope, modules and overall architecture                                            |
| [Local production implementation plan](IMPLEMENTATION_PLAN.md) | Complete phased build through Windows installation, recovery testing and store acceptance |
| [Render deployment continuation](RENDER_DEPLOYMENT_PLAN.md)    | Later central hosting, branch synchronization, migration, recovery and rollout            |

## Delivery order

1. Complete local phases **L0-L13**, including the local production acceptance gate.
2. Continue with Render phases **R0-R7**, preserving local checkout during internet outages.

The stack is React and TypeScript, a Node.js REST API, PostgreSQL, and a later Electron Windows client. The initial installation uses one local branch server shared by browser and desktop clients. Render later provides central management and synchronization.

The `frontend`, `backend`, `shared` and reserved `desktop` workspaces share one lockfile. `db:bootstrap` initializes the installation identity, not a user account. `db:seed:demo` and `build:desktop` remain explicitly deferred. `jce-website` stays separate. No cloud transport is enabled.
