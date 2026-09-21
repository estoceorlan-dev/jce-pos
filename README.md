# JCE POS

Business-specific answers and confirmations are stored only in `.local/business-intake/`, which Git ignores. This shared document contains generic planning guidance; consult the local records before applying defaults or requesting an already-recorded decision.

Point-of-sale and general merchandise management system for JCE Dry Goods Trading.

**L1 foundation implemented.** The React workspace, Express API, PostgreSQL migration checks, CI and tests are available. L0 rules and synthetic calculations are documented; real business records, hardware details and owner approval remain pending. Login, checkout and the Windows installer arrive in later milestones.

## Start locally

Use Node **24.21.0**, npm **11.19.0** and PostgreSQL **18**. Create an empty development database, then run from this directory:

```powershell
npm ci
Copy-Item .env.example .env
# Set DATABASE_URL in .env to your development database.
npm run build:server
npm run db:migrate
npm run start:server
```

Open **http://127.0.0.1:3000**. Express serves the built UI without Vite. `npm run dev` starts the development UI at port 5173. See the [development runbook](docs/runbooks/development.md) for configuration, script contracts and troubleshooting.

## Verify

```powershell
$env:TEST_DATABASE_URL='postgresql://jce_test:your_password@127.0.0.1:5432/jce_pos_test'
npx playwright install chromium
npm run verify:release
```

The test database must be disposable and end in `_test`; tests modify its migration metadata. Verification covers lint/formatting, strict types, unit/HTTP boundaries, real PostgreSQL and production browser journeys.

See [implementation decisions](docs/decisions/0001-local-baseline.md), [workflow/approval proposals](docs/decisions/0002-workflows-and-approvals.md), [L0 evidence still needed](docs/acceptance/l0-evidence-register.md), [calculation fixtures](tests/fixtures/l0-money-stock.json) and [verification evidence](docs/acceptance/l1-verification.md).

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

The `frontend`, `backend`, `shared` and reserved `desktop` workspaces share one lockfile. `db:bootstrap`, `db:seed:demo` and `build:desktop` currently fail explicitly with their target milestone. `jce-website` remains separate.
