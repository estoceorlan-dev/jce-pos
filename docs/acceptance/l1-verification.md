# L0–L1 verification evidence

Date: 2026-09-21. L1 implemented and verified locally on Windows x64 using Node 24.21.0, npm 11.19.0 and PostgreSQL 18.3.

| Check                  | Evidence                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeatable install     | `npm ci` passed against the root lockfile; audit reported zero known vulnerabilities                                                                    |
| Lint and formatting    | ESLint and Prettier passed                                                                                                                              |
| Strict TypeScript      | Shared, frontend, backend and tests passed                                                                                                              |
| Unit/HTTP tests        | 9 passed: config, pagination, default-deny navigation, SPA/API boundaries, readiness failure, request IDs, JSON validation and log privacy              |
| PostgreSQL integration | 4 passed: uninitialized DB, concurrent/repeatable migration, checksum drift and newer-schema rejection                                                  |
| Migration CLI          | `npm run db:migrate` passed against the isolated test database                                                                                          |
| Production build       | Shared contracts, Vite assets and backend compiled successfully                                                                                         |
| Browser journeys       | 6 passed across desktop and mobile Chromium: navigation, form validation, local-only resources, guarded deep links, loading/error/recovery and API 404s |
| Production hosting     | Browser tests started the built Express server with `NODE_ENV=production`; no Vite server                                                               |
| Visual inspection      | Desktop/mobile overview screenshots inspected; initial focus adjusted to prevent unwanted scrolling and browser journeys rerun                          |
| Repository hygiene     | Git initialized on main; secrets, exports, backups, PostgreSQL data and generated assets verified ignored                                               |
| CI                     | PostgreSQL 18.3 workflow configured with `npm ci` and the same verification pipeline; not yet executed on GitHub                                        |

The complete `npm run verify:release` pipeline passed. After the visual focus correction, the production build and browser journeys were rerun. Browser artifacts are generated under ignored `test-results/` and `playwright-report/`.

The test database used a separate PostgreSQL cluster on loopback port 55439. The existing PostgreSQL Windows service was not modified. The temporary test server is stopped after verification; no store database or permanent service was created. No remote repository, commit or deployment was created.

On this machine, the isolated runtime lives at `%LOCALAPPDATA%\jce-pos-tools\node-v24.21.0-win-x64`. To use it in a PowerShell session:

```powershell
$env:PATH="$env:LOCALAPPDATA\jce-pos-tools\node-v24.21.0-win-x64;$env:PATH"
```

Configure a development database and `.env` using the README before running the app; test infrastructure is not a store installation.

Scope: technical shell and proposed operating-rule documentation. Business modules, authentication, physical printing, LAN HTTPS installation, live business approval and L13 acceptance are outside this milestone. See the L0 evidence register for unresolved owner inputs.
