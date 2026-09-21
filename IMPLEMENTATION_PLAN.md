# JCE POS Implementation Plan: Local Production

Business-specific answers and confirmations are stored only in `.local/business-intake/`, which Git ignores. This shared document contains generic planning guidance; consult the local records before applying defaults or requesting an already-recorded decision.

Status (2026-09-21): L0 working decisions and synthetic fixtures documented; owner evidence/approval remains pending. L1 application shell implemented and locally verified. L2-L13 have not started.

Prepared: 2026-09-20. Source of scope: [ARCHITECTURE.md](ARCHITECTURE.md).

**Deliver a complete, supportable local POS before starting the cloud rollout.** This plan ends with a store using the installed system, a successful restore drill, and an accepted production release. The separate [Render deployment continuation](RENDER_DEPLOYMENT_PLAN.md) begins after that gate.

## 1. Current state and delivery boundary

At the start of planning, the project contained the architecture document and an empty README. L1 now provides application packages, migration compatibility metadata, tests and CI. Business modules and installers remain future work. See [L0 evidence](docs/acceptance/l0-evidence-register.md) and [L1 verification](docs/acceptance/l1-verification.md).

Local production includes all store operations: authentication, permissions, branches, catalog, inventory, purchasing, suppliers, customers, checkout, returns, transfers, reports, logs, settings, Windows installation, printing, backup, restore, and maintenance.

The initial operating model is one Windows host with a local Node.js API and PostgreSQL database. One or more Electron desktop clients or browsers connect to that host over the local network. The host can also be the first cashier workstation. A dedicated host is preferable when several tills are in use.

```text
Browser clients / Windows desktop clients
                   |
          Branch LAN with HTTPS
                   |
     Windows host: React assets + Node.js API
                   |
       PostgreSQL on the same host
                   |
       Encrypted backup on another device
```

Definitions that affect implementation:

- Internet loss must not prevent local login, checkout, receiving, stock adjustments, reports, or printing. Bundle fonts, icons, scripts, and other required assets locally.
- Loss of the branch host or LAN is different from internet loss. Clients cannot finalize sales without the local API. Preserve a pending checkout identifier, display its uncertain status, and reconcile it after reconnection; do not create an independent database on each till.
- Several branch records can share this installation and database. Transfers between those records are included in local production. Geographically separate databases require the later synchronization release before coordinated transfers or consolidated reporting are supported.
- The local release records synchronization events but does not contact a cloud service. Cloud accounts, Render, and external login providers are not local runtime dependencies.
- `jce-website` remains a separate project. E-commerce, online payment processing, loyalty, customer credit/accounts receivable, payroll, and a full accounting ledger are outside this baseline. Recorded cash/card/e-wallet tenders and customer purchase/refund history are included. Confirm these boundaries in L0.

## 2. Implementation decisions

These choices resolve alternatives left open in the architecture. Record changes as architecture decision records before building affected modules.

| Area | Baseline decision | Purpose |
| --- | --- | --- |
| Language and workspace | TypeScript throughout; npm workspaces with one committed lockfile | Shared contracts and repeatable builds |
| Frontend | React, Vite, React Router, TanStack Query, React Hook Form, Zod; a small shared accessible component layer | One UI for browser and desktop |
| API | Node.js 24 LTS, Express 5, versioned REST under `/api/v1` | A modular monolith with explicit domain services |
| Database | PostgreSQL 18; `pg`, parameterized SQL repositories, ordered SQL migrations | Explicit transaction and locking behavior |
| Authentication | Argon2id passwords and opaque server sessions persisted in PostgreSQL | Local login and immediate local session revocation |
| Desktop | Electron and electron-builder, Windows x64 installer | Shared React UI, scanner support, local receipt printing |
| Frontend hosting | API serves the production React build at the same origin | Simple sessions and one branch URL |
| Local services | PostgreSQL Windows service; Node service managed through a pinned Windows service wrapper; local HTTPS reverse proxy | Startup without an interactive user and supervised restart |
| Verification | Unit tests for domain calculations; real PostgreSQL integration tests; Playwright journeys; manual Windows hardware tests | Verify money, stock, and actual store operation |
| Logs and exports | Structured JSON operational logs; database audit trail; streamed CSV and server-generated PDF | Support diagnostics and reproducible reports |
| Synchronization foundation | Transactional outbox in `sync_queue`; cloud transport disabled | Preserve a later route to Render without delaying local use |

Node 24 is an LTS line at planning time; pin a supported patch and dependency versions when scaffolding, then test upgrades deliberately. [Node.js release policy](https://nodejs.org/en/about/previous-releases). Verify the chosen Vite/React/Express package versions together during L1 using their official setup documentation: [Vite](https://vite.dev/guide/), [Express](https://expressjs.com/en/starter/installing/).

Use one checked-out Git repository for `jce-pos`; L1 initialized it separately from `jce-website`. Development PostgreSQL may run in Docker; the store installation must work without Docker Desktop, npm downloads, or a developer terminal.

## 3. Decisions and evidence required in L0

The plan can be implemented using the defaults below. The owner and implementer must resolve changes before affected behavior is released.

| Decision | Working default | Required evidence |
| --- | --- | --- |
| Store topology | One writable installation; multiple tills on the LAN | Branch list, expected tills, host and router details |
| Currency and dates | PHP; `Asia/Manila`; UTC timestamps in storage | Business-day cutoff and sample reports |
| Tax and receipt rules | Configurable tax codes, inclusive/exclusive handling, receipt series | Owner/accountant-approved sample calculations, required receipt fields, and applicable registration requirements before live receipt use |
| Catalog | Every sellable SKU is a variant, including a default variant for simple products | Real SKUs, barcodes, units, packs, fractional quantities, minimum stock examples |
| Costing | Moving weighted-average purchase cost; sales snapshot their cost | Opening values and approved treatment of landed costs, returns, damage, and transfers |
| Checkout | Cash plus manually recorded approved tender types; no credit sale | Split tender, change, rounding, discounts, payment reference rules |
| Permissions | Administrator, owner/manager, branch manager, cashier, inventory staff | Signed permission matrix, approval thresholds, separation of duties |
| Hardware | Keyboard-wedge barcode scanner; Windows-installed receipt printer | Printer model, paper width, driver, cash drawer behavior and test device |
| Availability | Internet-independent; host and router protected by UPS | Power behavior, spare host, recovery contact |
| Recovery | Proposed RPO at most 60 minutes; RTO at most 2 hours | Backup destination, key custodian, timed restore rehearsal |
| Capacity | Provisional test envelope: 5 concurrent tills, 25,000 variants, 1 million sale lines | Actual first-year and three-year estimates |
| Historical data | Opening catalog/stock import; historical sales only if explicitly required | Clean source files, reconciliation totals, cutover date |

Receipt and tax configuration is an operational acceptance item, not a claim that software development alone establishes regulatory approval. Record the actual requirements and their sources in the L0 decision log.

## 4. Proposed repository layout

```text
jce-pos/
  frontend/src/
    app/                    # routes, session, branch context
    components/             # shared UI, tables, forms, dialogs
    modules/                # auth, POS, catalog, inventory, etc.
    api/                    # typed API client, error handling
  backend/src/
    modules/                # module routes, services, repositories
    middleware/             # sessions, permissions, validation, errors
    db/                     # pool, transaction helpers, migration runner
    audit/
    sync/                   # local outbox first; transport later
    reports/
    jobs/
    app.ts                  # application factory
    server.ts               # process startup and shutdown
  backend/migrations/
  backend/seeds/            # permissions/bootstrap; separate demo seed
  desktop/
    main/                   # window, printer bridge, endpoint settings
    preload/                # small validated IPC contract
  shared/src/               # DTOs, schemas, permission/event names
  tests/{integration,e2e,fixtures}/
  scripts/{windows,backup,release}/
  docs/{decisions,runbooks,acceptance}/
  package.json
  package-lock.json
  .env.example
  .github/workflows/ci.yml
```

L1 defines these root script contracts: `dev`, `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, `build:server`, `start:server`, `db:migrate`, `db:bootstrap`, `db:seed:demo`, `build:desktop`, and `verify:release`. `build:server` builds shared contracts, frontend assets, then backend JavaScript; it excludes Electron packaging. Bootstrap, demo seeding and desktop packaging currently exit with explicit deferred-milestone errors. See the [development runbook](docs/runbooks/development.md).

Keep business logic in backend services. Frontend calculations are previews; the server recalculates financial and stock effects. Share request/response contracts, not database credentials or trusted authorization decisions.

## 5. Data model and invariants

### 5.1 Schema work packages

Retain the architecture's entity families, with the following additions and clarifications.

| Package | Tables and responsibilities |
| --- | --- |
| Identity | `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `user_sessions`, `branch_users`; session expiry/revocation and approved role assignments |
| Organization | `business_settings`, `branches`, `branch_settings`, `installations`, `branch_ownership`, `terminals`, `document_sequences`; unique branch/terminal codes and one owner installation per writable branch |
| Catalog | `products`, `product_categories`, `product_brands`, `product_units`, `product_variants`, `product_barcodes`, `product_prices`, `tax_codes`; base-unit conversions and price history |
| Inventory | `inventories`, `inventory_movements`, `inventory_reservations`, `stock_adjustments`, `stock_adjustment_items`, `stock_counts`, `stock_count_items`; quantity and value per branch/variant/stock condition |
| POS and sales | `sales`, `sale_items`, `sale_payments`, `sale_discounts`, `sales_returns`, `sales_return_items`, `refund_payments`, `register_sessions`, `cash_movements`, `receipt_print_events` |
| Purchasing | `suppliers`, `purchase_orders`, `purchase_order_items`, `purchases`, `purchase_items`; each posted purchase is a goods-receipt document, with supplier invoice references |
| Transfers | `stock_transfers`, `stock_transfer_items`, `transfer_receipts`, `transfer_receipt_items`; reservations, shipment quantities, partial receipts and discrepancies |
| Customers | `customers`, `customer_transactions`; purchase/refund activity linked to source transactions, optional customer for walk-in sales |
| Audit and operations | `audit_logs`, `login_logs`, `backup_runs`, `job_runs`, `idempotency_requests`; operational `system_logs` in rotated files, with a restricted diagnostic view |
| Future sync | `sync_queue`, `sync_records`, `sync_conflicts`; immutable event payload plus mutable delivery state, versioned event schema and separate installation identity |

Migrate in dependency order. Add foreign keys, unique keys, nonnegative checks where appropriate, and indexes for branch/date, barcode/SKU, status, and event delivery. Never rely on UI validation as the sole data constraint.

### 5.2 Required rules

1. Generate UUIDs before database insertion. Keep human-readable document numbers separate, with unique branch/series/number constraints. Allocate numbers safely; a restart must not reuse them. Never recycle a posted receipt number.
2. Associate branch-owned data with a branch and originating installation. Shared catalogs and user assignments have explicit scope. APIs derive allowed branches from the authenticated session and check all object references, including exports and nested records.
3. Use PostgreSQL `numeric` for quantities, conversions, costs, and money; use decimal arithmetic in application code and serialize decimals as strings. Round tender totals to centavos under the approved rule. Preserve higher precision for fractional quantity and unit cost calculations.
4. Snapshot product description, SKU, unit/conversion, unit price, tax rule/rate, discounts, cost, cashier, and branch details on posted documents. Later catalog/settings changes must not rewrite history.
5. Every posted stock change creates an immutable movement and updates its balance in the same transaction. Current balances must reconcile to the ledger. Reservations affect available stock without pretending goods have moved.
6. Prevent overselling with locked inventory rows or guarded atomic updates, a consistent lock order, database constraints, and bounded retries for retryable database failures. Two tills selling the last unit must not both succeed. PostgreSQL documents row locks and their concurrency effects in [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).
7. Post a sale, payment records, inventory movements, balance changes, audit event, and synchronization event atomically. Use one checked-out `pg` client for the complete transaction. [node-postgres transaction requirements](https://node-postgres.com/features/transactions).
8. Require idempotency keys for posting sales, returns, receipts, adjustments, transfer transitions, and cash movements. Scope keys by installation and operation, hash requests, return the original result for identical retries, and reject reuse with different content. Enforce this in PostgreSQL so concurrent retries are safe.
9. Committed financial and stock documents are immutable. Corrections use linked reversal or compensating documents with a reason and authorized approver. Restrict application-role update/delete privileges on ledgers and audit records; use a separate migration role.
10. Track document versions for editable drafts; reject stale writes. State transitions must be validated server-side with their required branch permission.
11. Restrict cumulative return quantities/refunds to the eligible original sale after prior returns. Snapshot how original discounts and taxes are allocated across returned units; define the residual rounding rule.
12. Keep sale payment records separate from cash actually tendered and change. Never store card credentials. An external tender reference records the cashier's confirmation; it does not claim gateway settlement.
13. Stock valuation includes sale cost snapshots, return cost reversal, purchase weighted averages, and transfer value at dispatch. Prevent ordinary backdating into a closed stock/business period. Apply corrections in an open period with links to the original record.
14. Local customer transactions and report projections must not apply financial or stock effects a second time. Give derived records a unique source reference.
15. Never include passwords, session tokens, full payment credentials, or unnecessarily detailed customer data in audit payloads, logs, or synchronization events.

## 6. Delivery phases and dependencies

The numbered phases are implementation milestones, not permission prompts. Complete their exit criteria before relying on their behavior in later work. Build usable screens with their API/data work in each phase.

| Phase | Depends on | Milestone |
| --- | --- | --- |
| L0 | None | Operating rules and acceptance examples agreed |
| L1 | L0 | Repeatable scaffold and production-shaped application shell |
| L2 | L1 | Schema, transactional primitives, audit and outbox foundation |
| L3 | L2 | Secure login, branch access, users and settings |
| L4 | L3 | Catalog, suppliers, customers and validated import |
| L5 | L4 | Reconciled inventory ledger and stock control |
| L6 | L5 | Purchase orders and goods receiving |
| L7 | L5, L6 | Checkout, register sessions, payments and receipts |
| L8 | L7 | Returns, reversals and end-of-day reconciliation |
| L9 | L5, L8 | Complete local transfer lifecycle |
| L10 | L6-L9 | Reports, dashboards, logs and administrator operations |
| L11 | L3, L7-L10 | Windows desktop, hardware and deployable branch installation |
| L12 | L10, L11 | Recovery, upgrade, security and performance qualification |
| L13 | L12 | Reconciled cutover, pilot and accepted local production |

### L0. Confirm operating rules and implementation baseline

Working baseline and proposals: [ADR 0001](docs/decisions/0001-local-baseline.md), [ADR 0002](docs/decisions/0002-workflows-and-approvals.md). Missing owner evidence is tracked explicitly in the [L0 register](docs/acceptance/l0-evidence-register.md); business approval is not implied by scaffolding authorization.

- [ ] Inspect real receipts, price lists, purchase records, returns, stock counts, and transfer slips.
- [ ] Resolve section 3 decisions; record scope, chosen stack, topology, permissions, state machines, costing, rounding, and recovery objectives in `docs/decisions/`.
- [x] Create acceptance fixtures with manually calculated totals for tax, discount, split tender, change, fractional units, partial refund, and stock value. Eight synthetic fixtures exist; owner approval remains pending.
- [x] Define draft/post/approval boundaries and which actions require a second person; define how approvals expire and bind to the exact action being approved. Documented as proposals in ADR 0002.
- [ ] Record supported Windows/browser versions, actual printer/scanner models, data scale and launch branch.

**Exit:** the implementer can calculate expected money and stock changes for the main workflows without inventing business rules.

### L1. Establish the workspace and application shell

- [x] Initialize version control and ignore local secrets, customer exports, backup files, PostgreSQL data, logs and build outputs.
- [x] Scaffold the workspace, lockfile, strict TypeScript, lint/format settings, environment validation and script contracts.
- [x] Create the React layout, navigation, branch indicator, reusable forms/tables, keyboard focus conventions, empty/error/loading states, and permission-aware navigation. Default-deny shell; actual sessions and branch assignments are L3.
- [x] Create `/api/v1`, OpenAPI documentation, request IDs, structured logs, request validation, consistent error codes, pagination and bounded query limits. Pagination schema/middleware is ready for later domain list routes.
- [x] Add `/health/live`, `/health/ready`, and a version endpoint. Readiness checks database connectivity and compatible migrations; public responses reveal no credentials or detailed infrastructure.
- [x] Build the frontend into assets served by the API; SPA navigation must work without swallowing API 404 responses.
- [x] Set up CI with a real PostgreSQL service, clean installation, type/lint checks, tests and production build; add a Windows desktop build job when L11 lands. Workflow configured; equivalent checks passed locally, GitHub execution awaits a remote/push.

Evidence: [L1 verification](docs/acceptance/l1-verification.md). This milestone is an application shell, not a production POS release.

**Exit:** a clean checkout builds and starts a production-shaped local app; invalid configuration fails clearly; no development server is needed for the production build.

### L2. Build database and transactional foundations

- [ ] Implement ordered migrations, checksum tracking, a migration lock, clean database setup, and upgrade tests from the previous schema.
- [ ] Separate runtime, migration and backup credentials. Provide a one-time bootstrap command; keep demo data out of production migrations.
- [ ] Add shared transaction, idempotency, decimal, document numbering and audit helpers.
- [ ] Implement UUID installation identity, branch ownership, terminal identity, and an outbox insertion helper used within business transactions.
- [ ] Give outbox events an event UUID, origin installation, branch, aggregate ID/type/version, schema version, event type, payload, occurrence time and checksum. Queue delivery remains disabled locally.
- [ ] Protect immutable ledgers from ordinary edits and test transaction rollback at each critical write step.
- [ ] Define local retention and disk monitoring. Do not purge unsynchronized events; measure their growth and document the later snapshot/acknowledgement handoff.

**Exit:** failed operations leave no partial stock/money/audit/outbox changes; duplicate requests resolve to one operation; identifiers survive backup/restore and prepare for branch synchronization.

### L3. Deliver authentication, users, branches and settings

- [ ] Implement bootstrap administrator creation with a supplied secret, login/logout, password change/reset by an authorized administrator, session expiry, lock screen, account disable and login history.
- [ ] Persist sessions in PostgreSQL; use secure HttpOnly SameSite cookies, CSRF protection and origin checks for writes. Use local HTTPS for LAN clients; allow any insecure development mode only on development loopback.
- [ ] Add login throttling, bounded request sizes, secure headers, safe SQL parameters and redaction of secrets.
- [ ] Implement roles and granular permissions; prevent a branch manager from granting privileges or branch access they do not hold. Prevent accidental removal of the last recovery administrator.
- [ ] Deliver branch CRUD, memberships, branch switcher, terminal/register configuration, and branch-scoped settings. Archive referenced branches/users instead of deleting history.
- [ ] Deliver business identity, currency/date display, receipt settings, tax codes, allowed payment methods, discount thresholds and printer preferences. Record settings changes with history.

**Exit:** authorization integration tests deny direct API access to another branch's transactions, reports and exports; disabled accounts lose local access; approved branch switching works in browser and desktop shell.

### L4. Deliver catalog and business master data

- [ ] Build products, variants, categories, brands, units, barcode aliases, base-unit conversions, branch prices and price history.
- [ ] Support search by barcode, SKU and name, uniqueness checks, archive/reactivate, low-stock thresholds and permitted fractional quantities.
- [ ] Implement supplier and customer CRUD/search/archive, a walk-in customer flow and permission-controlled contact information. Customer history links to posted sales/refunds.
- [ ] Build catalog CSV templates and staged imports: parse, validate, preview, duplicate policy, error report, idempotent commit and audit. Opening stock is posted through L5, not written into balances here.
- [ ] Keep imported customer data and generated CSV safe for spreadsheet use; escape formula-like cells on export.

**Exit:** real sample merchandise can be imported, scanned, priced and edited without ambiguous SKUs or unintended changes to posted history.

### L5. Deliver inventory and stock controls

- [ ] Implement per-branch/variant balances, on-hand, reserved, available and quarantined/damaged quantities with a movement ledger.
- [ ] Deliver stock screens, low/out-of-stock filters, movement history and drill-down to the originating document.
- [ ] Post opening stock as a dated, valued, approved inventory document with an import manifest and reconciliation report.
- [ ] Implement reason-coded adjustments and stock counts. Use a scoped count freeze or an explicit movement cutoff so sales during counting cannot corrupt the adjustment.
- [ ] Implement cost calculations, reservation allocation/release, deterministic inventory lock order, and a read-only ledger-versus-balance reconciliation command.
- [ ] Require an audited, reviewed correction for a reconciliation failure; never silently overwrite the ledger to match a cached balance.

**Exit:** opening stock plus all movements equals on-hand stock and value; simultaneous deductions cannot oversell; reservations and damaged stock are excluded from saleable availability.

### L6. Deliver purchasing and goods receiving

- [ ] Implement purchase orders with `DRAFT -> SUBMITTED -> APPROVED -> PARTIALLY_RECEIVED -> RECEIVED`, with reject/cancel paths and controlled closure of unreceived quantities.
- [ ] Create supplier-linked goods receipts from approved orders, with quantities, unit conversions, cost, tax/discount data, supplier reference and receiving user.
- [ ] Validate partial and excess receipts using the approved policy; prevent duplicate posting. A purchase order alone never changes inventory.
- [ ] Posting a receipt updates quantity, stock value, weighted average cost, purchase history, audit and outbox atomically.
- [ ] Support correction/reversal of a posted receipt through a linked document, with a controlled rule if its stock has already been sold; do not edit the original receipt in place.
- [ ] Show outstanding orders, purchase/receiving history, supplier history and printable receiving documents.

**Exit:** repeated delivery requests cannot add stock twice; partial deliveries reconcile to order quantities and supplier totals; posted corrections preserve history.

### L7. Deliver POS, registers and payments

- [ ] Build a keyboard-first checkout screen with barcode input, search, quantities, customer selection, discount request/approval, tax display, hold/resume cart, cancel cart and clear totals.
- [ ] Add opening float and register sessions. A terminal has at most one open session; finalization requires a permitted cashier and an open session.
- [ ] Support cash, approved manually recorded noncash methods and split tender. Validate tender references, tender total, cash change and overpayment rules server-side.
- [ ] Revalidate prices, discounts, permission, product status and available stock at posting. Return a clear conflict when a cart requires cashier review.
- [ ] Persist a checkout request UUID before sending. If the response is lost, look up or retry that same request; never turn a timeout into a new sale automatically.
- [ ] Commit sale, line snapshots, payments, cash effect, stock/cost movements, customer history, audit and outbox together.
- [ ] Render receipts from committed snapshots. Add print/reprint history and a browser print layout; receipt printer support is qualified in L11. Printer failure must leave the sale committed and recoverable.
- [ ] Add transaction search, sale details, receipt lookup and a visible state for committed-but-not-printed sales.

**Exit:** two-till last-unit and double-submit tests pass; a timed-out successful checkout is recovered as the same sale; internet disconnection has no effect on local checkout.

### L8. Deliver returns, reversals and cash reconciliation

- [ ] Implement original-sale lookup, eligible return quantities, partial/full returns, reason codes and manager authorization.
- [ ] Refund original allocated prices/discounts/taxes; record refund tender separately. Support sellable restock versus damaged/quarantined return disposition.
- [ ] Distinguish discarding a draft cart from reversing a posted sale. A posted-sale void is a linked full reversal with its original receipt retained and its stock/payment effects applied once.
- [ ] Lock the original sale/return eligibility during concurrent refunds; prevent a full reversal after a partial return from refunding or restocking twice.
- [ ] Implement paid-in/paid-out cash entries, safe drops if used, closing counts, expected/actual cash, noncash totals, over/short and manager review.
- [ ] Define shift/business-day closing, late transactions and the approved reopening/correction procedure. Sales reports use consistent business-day boundaries.
- [ ] Provide a close summary reconciling opening float, cash sales, change, cash refunds and cash movements; compare net sales to payments net of refunds separately.

**Exit:** full and partial refunds, damaged returns, duplicate submissions and shift close reconcile exactly to financial and inventory fixtures.

### L9. Deliver local branch transfers

- [ ] Implement `DRAFT -> PENDING -> APPROVED -> IN_TRANSIT -> PARTIALLY_RECEIVED -> RECEIVED`, plus rejection/cancellation paths before shipment.
- [ ] Approval reserves source stock. Dispatch consumes the reservation, deducts source on-hand and records in-transit quantity/value in the same transaction.
- [ ] Destination receipt adds only the quantity actually received, preserving cost at dispatch. Validate against remaining dispatched quantity and prevent duplicate receiving.
- [ ] Model missing/damaged stock and short receipts explicitly; authorized discrepancy closure accounts for the remaining in-transit quantity/value.
- [ ] Cancellation before shipment releases reservations. After shipment, use receipt/discrepancy/return-transfer workflows rather than deleting or casually cancelling the transfer.
- [ ] Enforce separate source/destination branch rights, approval thresholds and requested separation of duties. Deliver transfer slips and history.

**Exit:** source, in-transit, destination and discrepancy quantities/value reconcile through partial receipts and retries. Two branch records in the same installation complete the entire flow. The UI clearly identifies independent-installation transfers as unavailable until the continuation is enabled.

### L10. Deliver reports, dashboards and operational administration

- [ ] Build all report families in section 7 with branch/date/user/product/category/payment filters where relevant, stable pagination and permission-controlled CSV/PDF exports.
- [ ] Derive money and stock totals from posted documents/ledgers with consistent refund, reversal, tax, discount, cost and timezone semantics.
- [ ] Build today's/monthly sales, transaction count, average transaction value, low/out-of-stock, pending purchases/transfers, recent activity and branch performance dashboards.
- [ ] Deliver audit and login history search, authorized operational diagnostics, backup status, version information and local service status. Redact customer/secrets from support bundles.
- [ ] Show synchronization as disabled for the local release, with event queue count/size visible to administrators; do not show an invented last-successful-sync time.
- [ ] Implement background execution/cancellation for expensive exports, bounded queries and indexes based on realistic data. Exports must preserve the same branch permissions as interactive views.

**Exit:** every report reconciles to a known fixture dataset; branch filters never expose unauthorized data; ordinary reports do not delay checkout beyond the acceptance target.

### L11. Package the desktop and branch installation

- [ ] Configure Electron to load the configured branch HTTPS origin, which serves the same React production build as browsers. Include a packaged connection/setup screen for a missing host and expose only the required printer/settings IPC.
- [ ] Disable Node integration in renderers; enable context isolation and sandboxing; validate IPC payloads and senders; restrict navigation, new windows and external links to approved destinations. Follow the [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security).
- [ ] Store endpoint/terminal configuration safely; keep database credentials out of all clients. Trust the branch certificate through a documented installer step; never bypass certificate errors globally.
- [ ] Integrate printer discovery, paper width, margins, receipt preview, print retries and authorized reprints. Test the actual barcode scanner and any cash drawer requested in L0.
- [ ] Produce separate server and client installation procedures. The server installs/configures supported PostgreSQL, the API service, HTTPS proxy, application files and backup jobs; clients only need the desktop installer or branch browser URL.
- [ ] Put writable configuration/logs/backups under controlled data directories such as `C:\ProgramData\JCE POS`; keep program binaries separate. Restrict service accounts and filesystem permissions.
- [ ] Configure service dependency/startup/restart, static host address or DHCP reservation, LAN DNS/certificate trust, firewall rules and host sleep prevention. PostgreSQL listens only where the local API needs it; tills never connect directly.
- [ ] Package prerequisites for installation without internet, checksums, version metadata, desktop signing strategy and an installer recovery path. Document certificate ownership and renewal.
- [ ] Add API/desktop compatibility checks, single-instance behavior per terminal and a controlled update prompt. Updates must not interrupt an active checkout or silently switch servers.

**Exit:** a clean Windows host and second till can be installed from release media, rebooted, logged into and used to scan/sell/print without a developer environment or internet connection.

### L12. Qualify recovery, maintenance and production behavior

- [ ] Implement scheduled encrypted PostgreSQL custom-format dumps plus configuration/certificate/receipt-asset backup. Include app/schema version, checksums, backup timestamp and a manifest; keep encryption keys separately recoverable. Use supported tools described in [PostgreSQL SQL backups](https://www.postgresql.org/docs/current/backup-dump.html).
- [ ] Start with a 30-minute backup cadence and copy to a physically separate device. Proposed retention: recent intraday copies for 2 days, 14 daily, 8 weekly and 12 monthly copies; confirm storage and retention in L0. A copy on the same host disk is not the recovery copy.
- [ ] Record duration/failure, monitor free space and alert on backup age. Verify that the measured recoverable snapshot remains within the agreed 60-minute RPO; if volume makes dumps too slow, implement and rehearse WAL-based recovery before launch.
- [ ] Restore to a clean spare machine, recreate roles and application services, verify ledger/report totals and receipt sequences, and time return to checkout against the 2-hour RTO. Keep the original host fenced to avoid two writable copies.
- [ ] Rehearse safe upgrade: backup, maintenance window, stop writes, apply migrations once, install version, smoke test, reopen. Use backward-compatible migrations where practical; restoring an old database after new sales requires explicit reconciliation of those sales.
- [ ] Test host reboot, forced API exit, database unavailability, disk-full behavior, interrupted printing, lost LAN responses and extended internet loss. Use test environments for destructive fault injection.
- [ ] Run targeted dependency/security checks, branch-authorization tests, session/CSRF tests, unsafe import/export cases and Electron IPC review.
- [ ] Run the capacity workload, profile slow queries and verify stock/money reconciliation afterwards. Complete staff/admin runbooks and restore/upgrade evidence.

**Exit:** recovery and upgrade procedures work from release artifacts; the measured workload passes; no unresolved defect can lose/duplicate money, stock, approvals, or branch access control.

### L13. Cut over, pilot and accept local production

- [ ] Stage a production candidate, create real user accounts and permissions, and train cashier, manager, stock receiver and administrator using their runbooks.
- [ ] Freeze legacy edits at the agreed cutoff, count stock, validate final catalog/prices and import opening stock/value through approved documents. Keep source files and reconciliation evidence.
- [ ] Enter outstanding orders/transfers through a reviewed opening workflow; do not import them as already completed stock movements. Confirm treatment of old returns and original receipts.
- [ ] Create the initial verified off-host backup and confirm recovery contacts, host/printer configuration, tax/receipt acceptance and support availability.
- [ ] Pilot one branch/till, then all planned local tills. Run at least five complete trading days including opening, sale, return, receiving, transfer, close and backup; use rehearsals for workflows not naturally occurring during the pilot.
- [ ] Reconcile daily cash/noncash totals, receipts, purchases and inventory differences; fix material defects and repeat affected acceptance checks.
- [ ] Tag the accepted release, archive installers and configuration manifest, assign maintenance/backup ownership, and record the local production gate below.

**Exit:** the business accepts the local release and can operate/recover it without a developer supervising normal trading. Only then schedule the Render continuation.

## 7. Architecture coverage and report inventory

| Architecture module | Local completion |
| --- | --- |
| Authentication and authorization | L3: local sessions, account lifecycle, permission/branch enforcement |
| Dashboard | L10: daily/monthly sales, stock alerts, pending work, activity and branch summary |
| Point of sale | L7-L8: scan/cart/discount/payment/receipt plus register close |
| Product management | L4: variants, units, barcode, pricing, categories/brands and import |
| Inventory management | L5: opening stock, counts, adjustments, reservations and movement/value ledger |
| Stock transfers | L9: approval, dispatch, partial receipt, discrepancy and history within one installation |
| Purchase management | L6: orders, receiving, corrections and history |
| Supplier management | L4/L6: master data and purchase history |
| Customer management | L4/L7/L8: profiles, walk-ins, purchase/refund history |
| Sales management | L7-L8: search/detail, returns, posted reversals and reprints |
| Branch management | L3/L9: branch settings, memberships, inventory and transfers |
| User management | L3: create/edit/disable, password reset, local sessions |
| Role and permission management | L3: independent permissions, role assignment, scope and escalation protection |
| Reports | L10: all families below, filtered CSV/PDF export |
| Audit logs | L2 onward; L10 search/export |
| System logs | L1 onward; L10 restricted diagnostics and rotation |
| Synchronization | L2 local outbox and identity only; transport/conflict resolution explicitly in the Render continuation |
| Backup and recovery | L12 implemented and rehearsed; L13 operational ownership |
| System settings | L3 settings; L11 device setup; L12 retention/maintenance |

Required report families:

- **Sales:** daily/weekly/monthly; by branch, cashier, product, category and tender; gross/net sales, discounts, taxes, returns and void/reversal listings.
- **Inventory:** current/low/out-of-stock, valuation, movements, adjustments, damaged/quarantined items, product movement and count variance.
- **Purchases:** purchase summary, supplier totals, purchase history, receiving details and outstanding orders.
- **Transfers:** history, pending/in-transit, completed, source/destination branch movement and discrepancies.
- **Users:** activity, login history, cashier transactions, administrative actions and approvals.
- **Financial summaries:** register reconciliation, tender totals, refund totals and gross margin derived from recorded cost. These are operational summaries, not a full general ledger.

## 8. Verification and production acceptance

Automate business invariants and integration boundaries; use physical-device acceptance for printing and installation. Do not substitute SQLite or mocked transactions for PostgreSQL concurrency verification.

| Area | Required proof |
| --- | --- |
| Money | Approved decimal/tax/discount/change/refund fixtures pass, including fractional units and rounding residue |
| Atomicity | Injected failures before commit produce no partial sale/payment/movement/audit/outbox; after commit the original result is recoverable |
| Concurrency | Competing last-unit checkout, double receiving, simultaneous refund and duplicate transfer receipts preserve stock/money |
| Access | Every sensitive API/export denies unauthorized branch IDs, guessed record IDs, stale sessions and privilege escalation |
| Offline behavior | WAN disconnected for a complete trading session; local login, sales, inventory, report and receipt workflows pass |
| LAN/host failure | Uncertain sale recovers by request ID; service restart returns to one consistent database; no browser-only sale is falsely marked complete |
| Hardware | Real printer output, long names, large receipts, paper outage, reprint and scanner tests pass on approved devices |
| Recovery | Restore from the separate backup device to a spare host meets RPO/RTO and preserves counts, money and numbering |
| Upgrade | Previous release database upgrades successfully; recovery and rollback limits are demonstrated |
| Performance | At agreed capacity: proposed p95 search <= 300 ms, checkout commit <= 1 second excluding printing, routine report <= 5 seconds; measure on production-equivalent hardware |
| Reconciliation | Inventory ledger/balances, purchase receipts, transfer conservation and register/financial totals match accepted fixtures and pilot totals |
| Operations | Reboot autostart, free-space alerts, backup failure visibility, log rotation and support runbooks verified |

These are proposed acceptance thresholds, not observed measurements. Record actual results, dataset size, hardware, commit/version and unresolved issues in `docs/acceptance/`.

### Local production gate

- [ ] L0-L13 exit criteria are complete with evidence.
- [ ] All architecture modules have their local capability or explicitly deferred sync scope accounted for.
- [ ] No unresolved critical/high defect affects sales, inventory, data access or recovery.
- [ ] Owner-approved receipt/tax behavior and actual peripheral tests are complete.
- [ ] Opening stock/value and pilot cash/sales/stock reconcile.
- [ ] Verified separate-device backup, restore drill and upgrade drill meet accepted targets.
- [ ] A named operator owns backups; a named maintainer owns releases and incident response.
- [ ] The accepted installer, source tag, schema version, support instructions and rollback limits are archived.

## 9. Scheduling and handoff

Estimate effort after L0 using the actual merchandise rules, hardware and data migration needs. Work in phase-sized reviewable changes; attach migration notes and acceptance evidence to each completed phase. Do not call an early checkout demonstration the production release.

The critical path is **foundation -> permissions/catalog -> inventory -> receiving/checkout -> corrections/transfers -> reports -> installation/recovery -> pilot**. Security, audit and transaction correctness begin with their modules rather than being postponed to final hardening.

Begin implementation with L0 and L1. Defer cloud credentials, paid services, production DNS and Render provisioning until [RENDER_DEPLOYMENT_PLAN.md](RENDER_DEPLOYMENT_PLAN.md) is scheduled after the local production gate.
