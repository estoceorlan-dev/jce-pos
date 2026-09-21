# Local retention and disk monitoring

L2 retains **all** audit records, document-number allocations, completed idempotency results and outbox events. It contains no automatic deletion job or sync sender. Runtime cannot acknowledge, delete or truncate outbox rows. Pending/unsynchronized events must never be purged for disk relief; losing them would make a later synchronization handoff incomplete. Demo data is never inserted into production migrations.

The server samples once at startup and every 60 seconds with no overlapping sample. It records structured, metadata-only logs with database bytes, total outbox relation/index bytes, pending-event count and oldest pending timestamp. Configure `STORAGE_MONITOR_PATH` to a directory on PostgreSQL's actual local data volume. Free bytes are checked against `STORAGE_MIN_FREE_BYTES` (default 5 GiB); low space emits `LOW_DISK_SPACE`. An omitted path emits `DISK_MONITOR_NOT_CONFIGURED` with database metrics; an inaccessible volume/database emits `STORAGE_MONITOR_UNAVAILABLE`. A missing sample is never represented as healthy disk space. These operational logs are not exposed through public health responses.

On-demand snapshot:

```powershell
npm run storage:check
```

Compare timestamped snapshots over a representative trading/rehearsal period. Estimate daily growth from the increase in outbox bytes/pending count and the total database size. Relation sizes include page allocation/index overhead, so small samples are not a per-sale forecast. Use actual domain events once those modules exist and include PostgreSQL WAL, operational logs, temporary query space and backup staging in storage capacity estimates. The L2 synthetic fixture measurements are recorded separately in acceptance evidence; they are not production sizing results.

On warning, the maintainer checks the correct volume and backup location, expands/moves storage through the installation procedure, and archives only eligible operational logs/backups under the approved operations policy. Do not delete ledger/audit/idempotency/outbox data or acknowledge events locally to clear an alert. Monitoring is advisory; L2 does not promise that a write succeeds on a full disk. Full-disk failure and supervised log rotation are L11/L12 qualification work. Until then, development logs go to stdout; external capture/rotation must be bounded by the operator.

## Later synchronization handoff

Before any retention change, the continuation must define a versioned consistent snapshot with installation/branch ownership, immutable identifiers, ledger balances and a durable outbox watermark. Transfer the snapshot and replay its remaining ordered/versioned events with idempotent receiver behavior. Persist verified remote acknowledgements; do not infer acknowledgement from connectivity or an attempted upload. Reconcile counts, values and source-event coverage, complete a restore rehearsal and document retention periods before an operator approves archival. Only then may a separately authorized archival job remove explicitly covered/acknowledged records under the accepted policy. Pending events remain protected, and audit/financial retention is a separate business decision.

Disk thresholds, recovery media and final retention periods are operational configuration. Business-specific ownership and equipment information belong only in ignored local records.
