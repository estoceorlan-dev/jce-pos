# JCE POS Continuation: Render Deployment and Branch Synchronization

Status: future implementation plan. Start after the local production gate in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

Prepared: 2026-09-20. Render platform constraints below were checked against official documentation on this date. Recheck supported versions, plan capabilities, regions and pricing before provisioning.

**Render becomes the central management and synchronization service. Branches keep their local API and PostgreSQL database for checkout.** Deploying the existing API to Render is only the hosting milestone; the cloud release is complete after safe data exchange, branch onboarding, recovery and pilot acceptance.

## 1. Target operating model

```text
Management browser
       |
       | HTTPS
       v
Render web service: React management UI + central Node.js API
       |                       |
       | private connection    +--> Render background worker
       v                              |
Managed Render PostgreSQL <-----------+
       ^
       | application events through the central HTTPS API
       | outbound connections initiated by each branch
       |
Branch A local API + PostgreSQL     Branch B local API + PostgreSQL
       ^                                  ^
       | LAN                              | LAN
Local POS clients                  Local POS clients
```

Operational boundaries:

- Local tills continue posting to their assigned branch host. They do not switch to the cloud API automatically when the host fails.
- Branch services push and pull application events over HTTPS. They do not connect to the Render database directly, expose their local database publicly, or require inbound router port forwarding.
- The central database consolidates transactions and holds centrally owned master data. It is not a second independent writer of a branch's stock or sales.
- The central UI starts with consolidated reporting and synchronization administration. Catalog/settings management is enabled only after master-data ownership changes have been tested. Local stock-changing routes are disabled in central mode.
- Cloud reports show each branch's last successful synchronization and the data's as-of time. Missing branches and stale data are explicit; a stale central stock count is never presented as a guarantee of current saleable stock.
- Separate branch databases gain coordinated transfers in this continuation. Transfers within one installation continue using the local transaction model.
- E-commerce integration with `jce-website` is a later project. It would need inventory reservation, order/payment and fulfillment contracts before it can safely sell branch stock.

An internet-dependent, cloud-only checkout deployment is a different operating model. It requires a separate decision and migration plan because it removes the local offline guarantee. It is not the default continuation here.

## 2. Entry requirements

- [ ] Local L0-L13 acceptance is complete and the installed release has a stable source tag.
- [ ] A restore drill, reconciled opening balances, production backup ownership and supported upgrade process exist.
- [ ] Branch/install IDs, UUID entity IDs, immutable posted records, decimal calculations, branch access control, idempotency and transactional outbox are in production.
- [ ] Outbox completeness is verified for every synchronization-relevant mutation, including master data and reversal documents. Transactions absent from an event are still covered by the bootstrap snapshot.
- [ ] The repository is available through the selected Git provider and CI can produce a Linux server build independently of Electron.
- [ ] Branch counts, expected event volume, acceptable report staleness, master-data ownership, rollout order and cloud operating budget are recorded.
- [ ] A maintainer is assigned to deployments, device credentials, synchronization incidents and central recovery.

## 3. Render resource plan

Use separate staging and production resources, databases, secrets and installation registrations. Staging receives synthetic or appropriately sanitized data; production branch agents must never accidentally enroll into staging.

| Resource | Initial use | Implementation choice |
| --- | --- | --- |
| Paid web service | Central API and React management UI | One Node service, same origin; production build, health checks and HTTPS |
| Paid managed Postgres | Central data, sessions, inbox/outbox, jobs and reports | Same PostgreSQL major as local; private connection from Render services |
| Paid background worker | Durable report jobs, distribution jobs, reconciliation and queue cleanup | Same server source tag; PostgreSQL-backed job leases initially |
| Scheduled backup job | Independent retained logical export | Render cron job with pinned PostgreSQL client tools, writing to encrypted external object storage |
| External object storage | Backup archives; retained large exports or uploaded assets if introduced | Private bucket, restricted credentials, retention and restore verification |
| Domain | Central management and synchronization endpoint | Stable HTTPS domain; enroll branch agents with this origin |
| Monitoring | Availability, errors, queue delay, disk/storage, backup age | Render metrics/logs plus selected alert destination; named operator |

Start with one web instance and one worker; measure before increasing either. Keep sessions/jobs/deduplication in PostgreSQL so process restarts do not lose them. Redis is not initially required. Long-running processing belongs in a worker, matching [Render's background worker model](https://render.com/docs/background-workers).

Select a region after measuring branch latency; Singapore is a candidate for Philippine branches. Keep the service, worker and database together. Check [Render regions](https://render.com/docs/regions). The cloud is off the checkout critical path, so reliability and operating cost matter more than shaving milliseconds off sale posting.

Use paid resources for production. Free web services can sleep, and free PostgreSQL has expiry and backup limitations unsuitable for this plan. [Render free-service limits](https://render.com/docs/free). Determine instance sizes and budget during R0; this document does not commit to a price or purchase.

## 4. Hosting constraints and configuration contract

### 4.1 Process and build behavior

The web process must listen on `0.0.0.0` using Render's `PORT`. Render terminates public HTTPS at its load balancer. Configure trusted proxy handling deliberately so secure cookies, client IPs and throttling work through that proxy. [Render web services](https://render.com/docs/web-services).

Implement the following configuration in R1-R2; the script names extend the local plan and are not available yet.

| Setting | Planned value or behavior |
| --- | --- |
| Runtime | Pinned supported Node 24 patch, aligned with CI and local server |
| Root directory | Repository root if `jce-pos` is its own repository; `jce-pos` if the parent workspace is the repository |
| Build command | `npm ci --include=dev && npm run build:server`; builds shared contracts, React assets and backend/worker JavaScript |
| Pre-deploy command | `npm run db:migrate`; one designated migration owner, migration lock, failure aborts promotion |
| Web start | `npm run start:server`; starts compiled JavaScript, not a watch/dev server |
| Worker start | `npm run start:worker`; starts compiled job processing, no public listener |
| Health check | `/health/ready`; database and compatible schema ready; bounded probe and no sensitive details |
| Release metadata | Source commit, application version, schema range and event protocol versions |
| Auto-deploy | CI-validated staging; controlled promotion of the same reviewed commit to production |
| Application disk | No persistent application disk; database/object storage hold durable state |

Do not set the Render root directory to `backend` if the build requires sibling `frontend` and `shared` packages: files outside the selected root are unavailable. Keep build filters inclusive of shared code, lockfile, migrations and frontend files. [Render monorepo support](https://render.com/docs/monorepo-support).

Render's pre-deploy command runs separately from the application and is available for paid services. Use it for database migrations, not build-time database writes or per-process migration races. Web and worker startup must tolerate the chosen schema compatibility window. [Render deploy lifecycle](https://render.com/docs/deploys). Use an HTTP readiness endpoint to reject unhealthy releases, following [Render health checks](https://render.com/docs/health-checks).

### 4.2 Environment and secrets

| Variable/group | Responsibility |
| --- | --- |
| `NODE_ENV=production` | Production behavior |
| `DEPLOYMENT_ROLE=central` | Enables central ownership rules; branch financial writes rejected server-side |
| `HOST=0.0.0.0`, `PORT` | Render-provided listening port |
| `DATABASE_URL` | Restricted application-role central connection, shared only with services that need it |
| `MIGRATION_DATABASE_URL` | Schema-management role; consumed only by the migration command, kept out of clients/logs |
| `APP_ORIGIN` | Exact management HTTPS origin used by session and CSRF validation |
| `SESSION_SECRET` | Central session protection secret; separate from every local installation |
| `TRUST_PROXY` | Deployment-specific, tested proxy trust setting |
| `SYNC_PROTOCOL_VERSION`, batch/size/time limits | Version negotiation and bounded resource consumption |
| Credential encryption key | Protection for centrally stored device secrets if the selected protocol needs recoverable secrets |
| Object-store configuration | Private endpoint/bucket and scoped credentials for backups/exports |
| `LOG_LEVEL`, release metadata | Diagnostics without secret disclosure |
| Branch-only settings | `DEPLOYMENT_ROLE=branch`, central HTTPS origin, installation ID, branch credential, `SYNC_ENABLED`; stored securely on the branch host |

Secret values must never appear in `render.yaml`, frontend `VITE_*` variables, repository files, public health responses or logs. Validate required settings at startup. Separate runtime and migration DB roles; where a service receives migration credentials for pre-deploy, keep them out of normal application code paths and rotate them under the operations policy.

Create an infrastructure blueprint only during implementation, validate it, and keep real secrets outside it. Specify production plan choices, environment separation, service/database region, build/start/pre-deploy commands and health path. Disable external Postgres access with an explicit empty `ipAllowList`, rather than relying on omission. [Render Blueprint specification](https://render.com/docs/blueprint-spec).

Use the internal database URL from Render services in the same account/region, and test the `pg` TLS configuration against Render's documented internal connection behavior. Administrative external connections must be encrypted and temporarily restricted to authorized source addresses. Branch agents receive only API credentials. [Render Postgres connections](https://render.com/docs/postgresql-creating-connecting).

### 4.3 Files and durable state

Render application filesystems are ephemeral by default. Do not retain receipts, imports, logs, backup dumps or user uploads only in a service directory. Generate receipts from immutable database snapshots; stream ordinary exports, and store retained artifacts in private object storage. [Render persistent-storage behavior](https://render.com/docs/disks).

The web service does not need a persistent disk. A disk would constrain scaling and deployment behavior, and it is not a substitute for managed database recovery. Temporary files must be disposable and cleaned up. Operational logs go to stdout/stderr; durable audit records remain in PostgreSQL.

Cron jobs cannot use a persistent disk and use UTC schedules. Backups must upload during the job and exit with a failure code when verification/upload fails. For example, 02:00 Manila is 18:00 UTC on the previous calendar day; label schedules in both timezones. [Render cron jobs](https://render.com/docs/cronjobs).

## 5. Data ownership before synchronization

Explicit ownership prevents local and cloud services from making contradictory changes.

| Data | Writable authority after onboarding | Replication and conflict rule |
| --- | --- | --- |
| Sales, payments, returns, register sessions, cash movements | Origin branch installation | Immutable posting events to central; corrections originate at branch |
| Purchase orders/receipts and stock adjustments/counts | Assigned branch installation | Versioned drafts or posted events; other installations cannot overwrite them |
| Inventory on-hand and value | Branch movement ledger | Central derives a projection; never synchronize an absolute stock number with last-write-wins |
| Product catalog, units, tax configuration, approved price lists | Central after explicit promotion | Versioned changes pulled by branches; local edits become authorized change requests after promotion |
| Branch-specific prices/settings | Central policy with an explicit branch override rule | Field ownership recorded; no ambiguous two-writer fields |
| Branch staff accounts and local sessions | Local installation in this release | Sync actor IDs/display metadata needed for reports; passwords and sessions remain local |
| Central management accounts and sessions | Central service | Separate administration and permissions; no shared browser session with local apps |
| Customers | Creating branch for editable contact data | Globally unique IDs; possible duplicates reviewed centrally; merges preserve IDs/history mappings |
| Shared suppliers | Central after initial deduplication | Local receiving can use already downloaded suppliers; urgent additions use a controlled provisional-ID/approval path |
| Cross-installation transfers | Source owns request/approval/dispatch; destination owns receipts; central coordinates | Immutable events and validated per-party transitions; conserve shipment quantity and value |
| Audit records | Origin installation or central service that performed the action | Append-only with provenance; receiving an event does not impersonate its original actor |
| Sync credentials and installation registry | Central administrator | One active owner per branch; device revocation does not require changing user passwords |

Before promotion, the local installation remains master of its catalog/settings. Freeze those edits briefly, reconcile IDs/versions and explicitly switch authority. Do not turn on central editing while both sides still believe they own the same fields.

Central user administration initially manages central accounts. Cross-branch staff provisioning or immediate remote revocation is not implied by synchronization: an offline branch cannot receive new policy until it reconnects. If remote staff management is required, add versioned provisioning/revocation commands, acknowledgement status and an owner-approved maximum offline authorization interval during R0. Local managers retain a documented immediate-disable procedure.

## 6. Synchronization implementation contract

### 6.1 Events and transaction boundaries

Extend the local outbox without changing local business posting guarantees.

1. A local business transaction writes its documents, stock/cash effects, audit and immutable outbox event together.
2. The branch agent leases pending events from PostgreSQL, sends bounded batches and persists attempt state. A crash expires the lease so another attempt can resume.
3. Central authenticates the installation and its assigned branches, validates event schema/version/size, and checks ownership and references.
4. In one central transaction, insert a unique inbox/deduplication record, apply the event's document/projection effects, append central audit/provenance and enqueue any downstream delivery. A duplicate event returns its original acknowledgement without repeating effects.
5. A successful acknowledgement means the event is durably applied. Validation/conflict responses are distinguishable from temporary failures. If asynchronous application is later introduced, `RECEIVED` and `APPLIED` must be separate statuses; do not silently weaken this acknowledgement contract.
6. Mark a local event acknowledged only after the acknowledgement is persisted. A lost HTTP response results in a duplicate delivery, handled safely at the receiver.

Use **at-least-once delivery with idempotent effects**. Do not promise exactly-once transport. One posted aggregate event should contain all necessary sale lines, tenders and stock/cost effects, or carry explicit dependencies and an atomic grouping scheme. The receiver must not apply stock once from the sale and again from a separately replicated movement.

Central ingestion must not run an already committed sale through checkout again or reject it merely because central prices or stock have changed. Validate origin, event structure, arithmetic, versions and ledger lineage, then preserve the original snapshots and effects. Quarantine inconsistent events for reconciliation without pretending the completed local sale was rolled back.

Each envelope includes event UUID, origin installation, branch, aggregate ID/type/version, event/schema version, occurrence timestamp, correlation ID and checksum. The authenticated device assignment must match the claimed origin. The same event ID with a different checksum is an integrity conflict, never an update.

### 6.2 Protocol and durable delivery state

Planned endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/sync/push` | Bounded event batch with per-event applied/duplicate/conflict/retry outcome |
| `GET /api/v1/sync/pull` | Lease pending master-data/transfer deliveries for the authenticated installation |
| `POST /api/v1/sync/ack` | Acknowledge specific deliveries after local durable application |
| `GET /api/v1/sync/status` | Own installation health, protocol compatibility and outstanding counts |
| Central admin installation/conflict endpoints | Enrollment, revocation, monitoring and audited resolution |

Use PostgreSQL inbox uniqueness on origin/event ID, aggregate version checks, and durable per-installation delivery records with explicit acknowledgement. A pull page must not skip an event merely because another transaction committed later with an earlier allocated ID. Do not implement correctness using wall-clock `updated_at > last_sync` or an unproven sequence high-water mark.

At each branch, applying a pulled change, recording inbox deduplication and preparing its acknowledgement occur in the same local transaction. Retrying after a crash cannot reapply it. Leases and delivery pages are bounded; unacknowledged items remain available after lease expiry. Preserve original event identity and mark imports so they cannot echo endlessly between branch and central.

Retry transient failures with exponential backoff, jitter and a cap. Treat authentication failure, incompatible schema and invalid data as actionable stopped/quarantined states rather than tight retry loops. A bad event must not indefinitely block unrelated aggregates; dependent events wait until their prerequisite is resolved.

Retain deduplication identities for at least the complete supported backup/replay lifetime; prefer compact permanent tombstones for posted financial events. Purge acknowledged payloads only under an agreed archival policy after backup verification. Never delete pending events just to reduce queue size.

### 6.3 Branch authentication and security

- Enroll with a short-lived, one-time administrator-issued token; bind the resulting credential to an installation and its permitted branch set.
- Store a generated high-entropy device credential in protected Windows service storage. Central stores a verifier/hash when the protocol permits it. Use TLS, rotation, revocation, per-installation throttling and audited enrollment; never use a shared company-wide sync password.
- Keep management sessions and device authentication separate. Enable MFA for privileged central accounts and document offline recovery codes.
- Reject forged branch IDs, oversized/compressed payload abuse, unsupported schema versions and missing dependencies before any business effect.
- Restrict synchronization endpoints to permitted actions; a branch credential is not a general central administrator token.
- Support current and previous agreed protocol versions during rolling upgrades; unsupported branches continue local trading while sync stops with a clear alert.

### 6.4 Conflict rules

| Conflict | Required response |
| --- | --- |
| Duplicate event with same content | Return existing applied result |
| Duplicate ID with different content | Quarantine, alert, preserve evidence |
| Stale catalog/draft version | Reject automatic overwrite; show expected/current versions and an authorized resolution path |
| Missing product/customer/transfer prerequisite | Defer the dependent aggregate; request/deliver prerequisite; retry safely |
| Inventory mismatch | Reconcile movement lineage; never overwrite branch stock from central totals |
| Independently created same SKU/barcode | Review identity mapping before activation; preserve posted line snapshots |
| Customer duplicates | Explicit merge mapping; preserve original transaction references and provenance |
| Unauthorized branch writer | Reject and alert; inspect installation registration |
| Restored or cloned branch database | Fence writes/sync until its identity, missing events and receipt series are reconciled |

All resolutions need a responsible user, reason, before/after mapping and a durable resolution event. Editing raw event JSON or deleting failed rows is not an operational resolution procedure.

## 7. Transfers between independent installations

Local database transactions cannot span disconnected branches. Implement the distributed lifecycle explicitly:

1. Source creates and approves the transfer, reserving stock locally.
2. Source dispatches exactly once, recording source deduction and shipment ID/line quantities/cost snapshots atomically. Its event is durable even without internet.
3. Central accepts the shipment and creates a destination delivery record.
4. Destination receives shipment metadata and records partial/full receipt locally. Each receipt has its own UUID and cannot exceed locally known remaining shipped quantities.
5. Destination receipt events reach central, which validates cumulative quantities and updates the transfer projection and source notification.
6. Short/damaged deliveries require an explicit discrepancy resolution; excess or unknown shipments are quarantined for review, not silently added as normal transfer stock.

Receipt posting is allowed while offline only when the validated shipment metadata was already downloaded. If it was not downloaded, staff can record a nonposting arrival note and hold the goods until validation. Do not assume a live HTTP request to both branches is possible.

Support return shipments as new linked transfers. A dispatched transfer cannot disappear through cancellation. Show source-stock, in-transit, received and discrepancy quantities/value, and their last sync times. Test conservation across duplicate dispatch/receipt events and long partitions.

## 8. Bootstrap and migration of existing local data

Treat onboarding as a repeatable migration with a report, not an ad hoc database restore over central production.

1. Inventory all installations, versions, branch IDs, catalog IDs, user/actor IDs, receipt series, balances and outstanding transfers/orders. Resolve duplicate branch ownership before enabling sync.
2. Upgrade the pilot branch to the compatible release while synchronization stays disabled. Create and verify a local backup.
3. Establish canonical master IDs. For the first branch, promote its reviewed catalog as the initial central catalog; for later branches, produce a mapping report for matching SKU/barcode/tax/unit/supplier records and review ambiguities.
4. Briefly quiesce writes and settle in-flight transactions. Take a consistent snapshot with a manifest of branch IDs, row counts, financial totals, ledger balances, schema/app versions and the exact outbox events covered by that snapshot. Reopen local writes; later changes remain in the outbox.
5. Import through a versioned, resumable bootstrap tool into central staging tables. Preserve original document/event UUIDs, actor provenance and posted financial snapshots. Never re-post imported historical documents as new sales.
6. Validate referential integrity, document counts, sales/payment/refund totals, inventory quantity/value, transfer states and receipt series. Record canonical mappings without losing original IDs on historical documents.
7. In a controlled central transaction, activate the imported branch projection and mark the snapshot-covered event IDs as represented. Then replay only uncovered events; test the snapshot/tail boundary for omission and duplication.
8. Enable push first with central views read-only. After reconciliation, enable pull, then promote master-data authority. Record each transition and maintain a way to pause synchronization while local sales continue.
9. Repeat for each additional branch with the same manifest and reconciliation checks. Do not restore a whole branch dump over a central database containing other branches.

For a shared local database containing multiple branches, import it once with its full owned branch set. If splitting that database into separate branch hosts, perform an additional planned migration: freeze affected branch writes, extract scoped data/dependencies, assign new installation ownership, fence the old owner, reconcile and only then resume. Copying a database and letting both copies trade creates two unauthorized writers.

## 9. Phased implementation and release gates

| Phase | Dependencies | Deliverables and exit gate |
| --- | --- | --- |
| R0: operational design | Local production gate | Confirm topology, branch authority, central access, staleness/recovery targets, budget, region, master data and rollout. Owner/maintainer accept the operating model. |
| R1: cloud compatibility | R0 | Add central/branch mode restrictions, Linux build, proxy/session behavior, health/readiness, graceful shutdown, durable jobs, version negotiation and bootstrap schema. Local regression suite still passes. |
| R2: staging infrastructure | R1 | Implement and validate `render.yaml`, isolated staging services/DB/secrets, restricted DB access, domain, migration pipeline, worker and backup tooling. Fresh deploy and redeploy pass without persistent app disk. |
| R3: synchronization engine | R1-R2 | Implement enrollment, push/inbox/deduplication, pull/delivery ACKs, retries/leases, compatibility, conflict UI and branch health. Two simulated branches pass partition/replay tests. |
| R4: central operations | R3 | Central roles/MFA, consolidated reports with freshness, canonical catalog/price publication, branch monitoring and distributed transfer flow. Ownership restrictions hold at the API layer. |
| R5: bootstrap rehearsal | R3-R4 | Rehearse snapshots, mappings, resume/retry, tail replay, shared-database onboarding and restoration on staging. All per-branch totals and stock/value reconcile. |
| R6: production deployment and pilot | R2-R5 | Provision production resources from the reviewed configuration, migrate once, bootstrap one branch, enable features in stages and observe at least five full trading days. Local outage behavior and central totals pass. |
| R7: branch rollout and handover | R6 | Enroll remaining branches one at a time, validate transfers, rehearse central/branch recovery and deployment rollback, document support and accept production. |

### R1-R2 deployment tasks

- [ ] Add `start:worker`, synchronization and bootstrap tooling while preserving the local plan's script contracts.
- [ ] Exclude Windows-only service/install code and Electron packaging from Linux server builds. Verify native password-hashing/PDF dependencies on Render's selected runtime.
- [ ] Handle termination by stopping new work, completing or safely releasing active leases, closing database connections and leaving retryable requests recoverable.
- [ ] Put sessions, queue leases and idempotency records in durable storage; verify behavior across restart and two overlapping deployment instances.
- [ ] Limit database pool size per process and budget for web instances, worker, cron/migration connections and deploy overlap. Measure against the purchased database's limit.
- [ ] Add a migration advisory lock and backward-compatible schema rollout. Let one service perform migrations; start/deploy the worker only against its supported schema range.
- [ ] Rehearse a failed migration, failed readiness check and application startup failure in staging.
- [ ] Verify frontend deep links, API errors, CSRF/session cookies, central route restrictions and runtime configuration after every deployment.
- [ ] Protect production Git/Render access and secrets; archive release/configuration metadata and recoverable credentials under the operations policy.

### R3-R5 integration tasks

- [ ] Add real multi-database tests: central plus two independent branch PostgreSQL databases.
- [ ] Test duplicate/out-of-order events, lost acknowledgements, expired leases, event version gaps, clock skew, incompatible clients and bad payloads.
- [ ] Verify an event cannot update an unassigned branch, impersonate another installation or grant central permissions.
- [ ] Demonstrate that replaying a sale event and its contained stock effects cannot deduct stock twice.
- [ ] Test master-data promotion, stale branch prices, archived products and historical sales using old tax/price snapshots. Define how downloaded future-effective price changes become active locally.
- [ ] Verify catalog/supplier/customer mapping before second-branch activation; preserve all historical references.
- [ ] Complete distributed transfer tests, including offline receipt with previously downloaded shipment data and unknown-shipment quarantine.
- [ ] Rehearse resume after a failed bootstrap and replay at the snapshot boundary; compare both transaction counts and financial/stock totals.

### R6-R7 rollout tasks

- [ ] Deploy the tested source tag to production; verify paid database backups, independent exports, domain/TLS, monitoring, central MFA and database access restrictions.
- [ ] Register the first branch, record its bootstrap manifest, enable push, reconcile, enable pull, then enable central master-data editing and cross-installation transfers when ready.
- [ ] Monitor the pilot through busy trading, a deliberate WAN outage, reconnect/catch-up, report generation, a deployment and daily reconciliation.
- [ ] Set alert thresholds from measured behavior; train the maintainer to pause sync, revoke a device, inspect a conflict and recover without deleting queue records.
- [ ] Add subsequent branches one at a time and close their acceptance report before the next onboarding.
- [ ] Archive the accepted central release, supported branch/protocol versions, recovery runbooks, resource/billing ownership and escalation contacts.

## 10. Backup, recovery and rollback

### 10.1 Central backups

Use paid Render PostgreSQL point-in-time recovery plus independent encrypted logical exports. Render's documented recovery window depends on the workspace plan; confirm it against the required retention before purchase. Recovery creates a separate database that can be checked before reconnecting services. [Render PostgreSQL recovery and backups](https://render.com/docs/postgresql-backups).

Start with daily independent exports, a checksum/manifest, object-store retention matching the agreed business policy and a monthly restore drill. Use a pinned compatible `pg_dump` client in the cron image. Monitor both platform backup health and external export age; an untested export is not recovery evidence.

R0 must distinguish three measures: loss of local committed sales, loss of centrally authored master-data changes, and delay before consolidated reports catch up. Proposed central target: RPO at most 60 minutes for central-authored changes and RTO at most 2 hours, demonstrated using the selected PITR capability or more frequent exports. Branch replay can rebuild branch-origin data only if the necessary event history still exists.

### 10.2 Central restore procedure

1. Pause branch synchronization and central writes; let branches keep trading locally.
2. Restore to a separate database and verify schema compatibility, counts, ledgers, central catalog versions, inbox/delivery state and device registry.
3. Compare each branch's retained event history against the restored central applied-event inventory. Requeue missing branch events even if the branch previously received an acknowledgement; normal pending-only push is insufficient after central rollback.
4. Reconcile central-origin changes acknowledged by branches after the chosen restore point. Recover from retained central event archives or reviewed branch inbox copies and audit records; do not overwrite a newer branch version with an older restored value automatically.
5. Invalidate/reissue sessions or credentials where needed, update services to the validated database, restart synchronization in stages and reconcile again.

Retain immutable central master-data events and branch delivery receipts for this recovery window. A restored central database must not silently reuse event IDs or replay old commands as new ones.

### 10.3 Branch restore procedure

Fence the old host, restore its local backup and reconcile against central for branch events that occurred after the backup. Recover acknowledged events in a dedicated recovery mode that preserves original IDs and does not emit new sale events. Check missing unacknowledged transactions against local backup/event archives and receipts; synchronization cannot recover records that never reached any surviving copy.

Before resuming writes, reconcile stock/cash, receipt/document sequences, event deduplication and aggregate versions. Rotate device credentials when replacing hardware. Prevent a copied database from running as another active owner of the same branch.

### 10.4 Release rollback

An application rollback does not undo database migrations or events already applied to other installations. Use expand/backfill/contract migrations; delay destructive cleanup until the agreed previous branch/central versions have been retired.

If a cloud release misbehaves, pause synchronization and central edits, return to a schema-compatible application version, and preserve local trading. Correct bad committed transactions with audited compensating events. Restoring an earlier database is a recovery operation requiring the replay/reconciliation procedures above, not a routine deploy rollback.

## 11. Acceptance tests and operational targets

Targets below are proposed defaults to confirm in R0 and measure in staging/pilot.

| Scenario | Required result |
| --- | --- |
| 24-hour WAN outage at a branch | Full local operations continue; queue persists across restart; central flags branch data stale |
| Reconnect after outage | All retained events arrive without duplicated stock/money; proposed catch-up <= 30 minutes for the measured one-day backlog |
| Healthy connection | Proposed p95 event visibility <= 60 seconds at planned branch volume |
| Duplicate HTTP delivery or lost ACK | One business effect; subsequent attempts return original result |
| Out-of-order/missing dependency | Dependent events wait or show actionable conflict; unrelated aggregates continue |
| Simultaneous deployments/workers | No duplicate queue effect, lost lease or session reset caused by in-memory-only state |
| Catalog conflict | Version/owner checks reject overwrite; posted historical prices/taxes remain intact |
| Transfer across disconnected branches | Source, in-transit, receipt and discrepancy conservation holds after reconnect |
| Device revocation/spoofing | Central rejects the credential or unauthorized branch; local offline effects follow the documented policy |
| Bootstrap snapshot plus live tail | No gap or duplicate at the boundary; all per-branch totals/value reconcile |
| Central restore to an older point | Previously acknowledged but now missing events are recovered; central-origin version divergence is resolved |
| Local host restore/clone | Only one active writer; IDs, document series and missing transactions reconciled before reopening |
| File loss/redeploy | No durable data or required receipt/export history is lost with the application filesystem |
| Capacity | Planned branches/batch volume plus reports stay within CPU/memory/connection budget; checkout remains local and unaffected |
| Security | Central branch scoping, CSRF/MFA/session revocation, payload limits, secret redaction and least privilege pass |

Monitor branch heartbeat, last applied event, oldest pending event age, pending count/bytes, conflict count, retry/auth failure rate, API latency/errors, worker lease age, DB storage/connections, backup age, restore-test date and application/protocol versions. Distinguish a planned offline branch from an unrecoverable backlog.

## 12. Render production completion gate

- [ ] Local operation still meets its original acceptance criteria with cloud unreachable.
- [ ] Production resources, secrets, HTTPS, health checks, migration ownership and database network restrictions are documented and tested.
- [ ] All enabled branches have unique ownership and reconciled bootstrap manifests.
- [ ] Push/pull/retry/deduplication, version negotiation, conflicts and distributed transfers pass their acceptance cases.
- [ ] Central reports expose freshness and reconcile to branch sales/payments/refunds and stock/value ledgers.
- [ ] Paid database recovery and independent backup retention meet the agreed targets, with actual restore evidence.
- [ ] Central rollback, branch restore and central restore/replay have been rehearsed.
- [ ] Five complete pilot trading days and per-branch rollout acceptance are recorded without unresolved critical/high data-integrity issues.
- [ ] A named maintainer owns alerts, patching, credentials, backups, costs and incident handling.

The result is a local production POS with a separately operated central Render service. Further work, such as cloud-only checkout or `jce-website` commerce, starts from a new approved scope rather than changing transaction ownership implicitly.
