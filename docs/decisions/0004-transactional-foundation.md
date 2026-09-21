# ADR 0004 — Database and transaction foundation

Date: 2026-09-21. Status: implemented in L2. This changes technical infrastructure only. Private business answers remain in the Git-ignored local intake; no tax, discount, return exception or receipt-format proposal becomes approved through this change.

## Scope and schema

Schema 2 introduces installation identity, branches and ownership, terminals, document sequences and immutable number allocations, idempotency history, append-only audit metadata and a local outbox. `database_security` is provisioned once before migrations to record the three database service roles. A dedicated administrator adopts an empty or L1-only database; migrations then execute as the non-superuser schema owner. Schema 1 SQL and checksum remain unchanged.

Identity/authentication tables belong to L3, catalog tables to L4, inventory ledgers to L5, and sales/payment tables to L7. The rollback tests use explicitly test-only sale/payment/movement/balance tables to prove the shared infrastructure without inventing those domain rules. No financial or stock posting endpoint exists in L2. The only UI change is the milestone indicator; the existing shell continues to show service readiness and unavailable business screens.

## Database credentials

Provision distinct runtime, migration and backup login roles with distinct supplied passwords. None may be superuser, create roles/databases, replicate or bypass RLS. Runtime and migration roles are checked against the provisioned identities; runtime readiness fails for an administrator/migration credential. Service roles must have no role memberships. The administrator retains database ownership; the migration role owns the trusted `public` schema and application objects.

Runtime can read foundation tables and perform only the inserts/column updates required by their helpers. It cannot create tables, modify migration/security metadata, delete/truncate histories, change installation identity, or acknowledge/send/purge outbox events. Backup has SELECT privileges, including default SELECT on future migrator-created tables/sequences. Only the migration role receives schema ownership. A backup is sensitive even though its database role is read-only.

Separate ignored credential files keep elevated credentials out of the normal server command. `db:provision` is one-time infrastructure setup; `db:bootstrap` initializes the singleton installation, audit record and outbox event transactionally and may safely be repeated. L3 will supply a separate administrator-user enrollment flow. Neither command creates a demo branch, cashier or business record.

## Transactions and idempotency

All transactional helpers require one checked-out client managed by `withTransaction`. Retry only PostgreSQL serialization/deadlock failures, with bounded exponential jitter (two retries by default, at most five). Never auto-replay a connection failure with an uncertain commit outcome. Callback code may execute again and must contain database work only. Printing, file writes, network calls and messages belong outside the transaction, after commit/outbox handling. This follows [node-postgres's same-client transaction requirement](https://node-postgres.com/features/transactions).

Idempotency is scoped by installation, operation and UUID request key. Canonical JSON sorts object keys and preserves array order and decimal strings; SHA-256 hashes the input without storing the original request. PostgreSQL uniqueness serializes concurrent claims. The original bounded JSON result is stored in the same transaction and returned for identical retries, including after reconnect/restore. Different content under the same key fails with `IDEMPOTENCY_CONFLICT`. No incomplete claim may commit: a deferred constraint checks completion. Finished results are immutable, and no TTL expires a financial retry key.

Domain services must authenticate and authorize **before** both first execution and replay, and include actor, branch, target version and relevant inputs in the request hash. Cache only the minimal result (IDs, numbers, decimal totals), never tokens, credentials or customer contact details. Canonical JSON rejects ambiguous/unsupported values and floating-point numbers; decimal quantities are strings. This is a deterministic internal checksum format, not a claim of an external canonicalization standard or a cryptographic signature.

## Identity, numbering and immutable records

Generate UUIDs in the application before insertion. The database has one installation identity; each branch must have exactly one ownership row by transaction commit. Terminals reference the composite branch/installation ownership, so a mismatched reference fails. Branch/terminal business names and codes are provided later through authorized workflows, not seeds.

Document number allocation upserts and locks a branch/series counter, advances by exactly one and inserts a unique allocation in the same transaction. Numbers use `bigint` and cross the API boundary as strings. A committed number is never recycled. Rolled-back unposted allocations may be reused; never print or present a final receipt number before commit. Existing terminal, installation, number and event IDs survive reconnect and logical dump/restore. A restored clone retains the source installation identity and must not be used as a second independent writable installation; later synchronization enrollment must distinguish a replacement host from a new installation.

Audit entries contain typed reference metadata, not arbitrary before/after objects or free-text sensitive payloads. Runtime privileges plus triggers prohibit UPDATE/DELETE/TRUNCATE of immutable foundation records. Future ledger migrations must apply equivalent controls. The schema owner can intentionally change DDL for maintenance; these controls protect against ordinary runtime writes, not a hostile superuser.

## Outbox and storage

Outbox envelopes contain event UUID, origin installation, optional branch, aggregate type/ID/version, event schema version, event type, strict versioned payload, occurrence time and checksum. Initial payloads cover installation/branch/terminal creation and contain IDs only. Every later domain event needs an explicit reviewed schema; copying HTTP bodies into an event is disallowed. Audit/outbox insertions participate in the caller's transaction.

Envelope fields are immutable. Separate delivery columns exist for future transport, but runtime has no delivery permissions and there is no network worker in L2. Events remain pending locally. Monitoring samples database/outbox size, pending count/age and optional data-volume free space. No event, document number, audit or idempotency purge runs. Retention and the future snapshot/acknowledgement handoff are documented in the [storage runbook](../runbooks/storage-retention.md).

## Decimal policy boundary

`decimal.js` performs bounded base-10 string calculations with an isolated 100-significant-digit context, enough for exact multiplication of the accepted operands (up to 24 integral and 18 fractional digits). Addition/multiplication return strings. Division and quantization require explicit scale and one of half-up, half-even or down; there is no implicit centavo rounding policy. These are numerical primitives, not approved tax, discount, weighted-average valuation or return-allocation implementations. PostgreSQL domain-specific `numeric(p,s)` bounds arrive with the domain schemas.

References: [PostgreSQL role/object privileges](https://www.postgresql.org/docs/18/sql-grant.html), [deferred constraints](https://www.postgresql.org/docs/18/sql-set-constraints.html), [decimal.js API](https://mikemcl.github.io/decimal.js/).
