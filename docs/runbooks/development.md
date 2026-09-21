# Development and verification

Requirements: Node **24.21.0**, npm **11.19.0**, PostgreSQL **18**, PostgreSQL 18 client tools and a dedicated development database. Tests require a disposable database ending in `_test` on a dedicated test cluster; they recreate its schema and temporary roles/databases. Never use a store database for tests.

## Start locally

First follow [database setup and upgrade](database-foundation.md) to configure three separate service credentials and ignored provision/migration files. From the repository root:

```powershell
npm ci
Copy-Item .env.example .env
# Edit runtime DATABASE_URL and APP_ORIGIN=http://127.0.0.1:3000 in .env.
# Keep ALLOW_INSECURE_LOOPBACK=true only for development loopback.
npm run build:server
npm run db:provision
npm run db:migrate
npm run db:bootstrap
# Supply .local/admin.env as described in the accounts/catalog runbook.
npm run auth:bootstrap
npm run start:server
```

Open `http://127.0.0.1:3000`. Express serves the compiled React application without Vite. Production requires HTTPS, `ALLOW_INSECURE_LOOPBACK=false` and an HTTPS `APP_ORIGIN`; see [accounts/catalog setup](accounts-and-catalog.md). Startup verifies the runtime role and requires a reachable database. A database outage leaves shell/liveness available but readiness returns 503. Readiness also rejects elevated or incorrect runtime credentials. `MIGRATION_DATABASE_URL` is mandatory for migration/bootstrap and belongs only in `.local/migration.env`; runtime uses `DATABASE_URL` from `.env`.

For development, `npm run dev` starts the API and Vite at `http://127.0.0.1:5173`. Vite proxies `/api` and `/health` to API port 3000; retain that port or update the proxy. Restart `dev` after editing shared contracts to rebuild them. Assets use system fonts and local bundles.

## Verification

Server and storage commands read `.env`; migration/bootstrap read `.local/migration.env`; provisioning reads `.local/provision.env`. Tests require explicit process environment:

```powershell
$env:TEST_DATABASE_URL='postgresql://jce_test:your_password@127.0.0.1:5432/jce_pos_test'
$env:PG_BIN_DIR='C:\Program Files\PostgreSQL\18\bin'
npx playwright install chromium
npm run verify:release
```

The pipeline runs formatting/lint, strict types, unit/HTTP tests, real PostgreSQL role/upgrade/atomicity/idempotency/concurrency/dump/restore checks, production build and desktop/mobile Chromium journeys. It verifies this milestone, not L13 production acceptance. CI uses a disposable PostgreSQL service and PostgreSQL 18 clients after `npm ci`.

Browser tests run the built API on port 3100 and refuse to reuse an existing service. Integration tests leave the database initialized with restricted synthetic test roles. Browser tests reset and seed the disposable database before starting the API. To run them alone, first run `build:server`. Do not run integration and browser suites simultaneously against one database. Playwright uses the derived test runtime connection, not the test administrator.

| Script                         | Contract                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| `dev`                          | Shared build, API watch and Vite                                       |
| `lint`, `format`, `typecheck`  | ESLint, Prettier and strict TypeScript                                 |
| `test:unit`                    | Configuration/contracts and HTTP boundaries                            |
| `test:integration`             | PostgreSQL roles, upgrades, concurrency, rollback, restore and storage |
| `test:e2e`                     | Production browser journeys                                            |
| `build:server`, `start:server` | Shared + web + API build; start compiled server                        |
| `db:migrate`                   | Transactional locked SQL migrations with checksums                     |
| `db:provision`                 | One-time separate PostgreSQL roles and schema ownership                |
| `db:bootstrap`                 | Initialize one persistent installation identity, audit and outbox      |
| `auth:bootstrap`               | One-time administrator from ignored .local/admin.env                   |
| `storage:check`                | Read-only database/outbox/data-volume metrics                          |
| `db:seed:demo`                 | Synthetic data in an empty _demo/_test database; supplied credentials  |
| `build:desktop`                | Fails explicitly until L11                                             |
| `verify:release`               | Current milestone verification pipeline                                |

## API and operational behavior

`GET /health/live` checks process liveness; `/health/ready` checks runtime credential privileges, connectivity and exact migration history/checksums. `/api/v1/version` returns app/API/schema versions (schema 4). `/api/v1/openapi.json` serves the OpenAPI 3.1 contract. Storage metrics are operator logs/CLI only; see [retention and monitoring](storage-retention.md).

Responses include generated `X-Request-ID`. Errors follow `{ "error": { "code", "message", "requestId" } }`. API/health 404s stay JSON even when HTML is requested. SPA navigation serves the built app; missing file assets remain 404. JSON bodies are limited to 64 KiB. Shared pagination validates page 1–10,000 and limit 1–100; management search endpoints enforce these limits.

JSON logs contain request ID, method, status and elapsed time. URLs, headers, bodies, tokens and database error details are excluded. Public health responses contain no infrastructure/credential details. Authentication requires HTTPS except explicit development/test loopback. Sessions, roles, branch settings, catalog/partner CRUD and staged imports are implemented; see the [API contract](/api/v1/openapi.json) when running locally and [technical decisions](../decisions/0005-identity-and-master-data.md). Windows service supervision, installed certificate trust and log rotation are qualified in L11.

## Troubleshooting

- `EBADENGINE`: activate pinned Node 24; the global Node 22 is unsupported for this workspace.
- Invalid configuration: compare reported keys to `.env.example`; check PostgreSQL URL scheme and port. Errors do not echo secret values.
- Readiness 503: check reachability and database-role access, run `db:migrate`, and verify matching application/migration history. Never edit recorded checksums to bypass mismatches.
- Missing production assets: run `npm run build:server` first.
- Port conflict: use a free port or stop the related development process. Do not stop unrelated PostgreSQL services.
