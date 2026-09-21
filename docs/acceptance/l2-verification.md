# L2 foundation verification

Recorded: 2026-09-21. Platform: Windows x64, Node 24.21.0, npm 11.19.0, PostgreSQL 18.3 and PostgreSQL 18 client tools. Tests used an isolated loopback PostgreSQL cluster and synthetic data only. The existing PostgreSQL Windows service and private business records were not modified.

## Automated evidence

`npm ci` and `npm run verify:release` passed locally. Final coverage comprises formatting/lint, strict TypeScript, **13 unit/HTTP tests**, **17 PostgreSQL integration tests**, production build and **6 desktop/mobile Chromium journeys** (36 tests total). After the full pipeline, a final transaction-abort regression was added and targeted lint, type checks, the integration suite and backend build were rerun.

| Area                       | Demonstrated behavior                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations                 | Clean provisioning; concurrent/repeatable upgrade from schema 1 to 2; original checksum/timestamp retained; partial migration DDL/history rolled back on injected conflict; altered/newer histories and downgrades rejected                    |
| L1 adoption                | An administrator-owned L1 database transferred to restricted role ownership and upgraded without rewriting its migration evidence                                                                                                              |
| Privilege separation       | Runtime/migration identity checks; runtime denied DDL, migration writes, identity replacement, immutable history changes and transport acknowledgement; backup denied writes and successfully ran `pg_dump`                                    |
| Installation and ownership | Concurrent bootstrap produces one persistent UUID; branches require exactly one owner at commit; terminal ownership mismatch and duplicate code rejected                                                                                       |
| Idempotency                | Eight simultaneous retries execute one callback; identical retry after reconnect returns original result; payload mismatch rejected; operation scopes separated; incomplete claims and commit-time constraint failures leave no result/effects |
| Document numbers           | Twelve concurrent allocations produce distinct sequential numbers; a new connection continues at 13; sequence rewind and history changes denied                                                                                                |
| Atomicity                  | Injected failure after claim, sale, payment, movement, balance, number, audit and outbox writes leaves no partial effects; final deferred commit failure rolls back its completed idempotency result                                           |
| Concurrent stock fixture   | Two transactions competing for the last fixture unit yield one success and zero ending stock                                                                                                                                                   |
| Retry behavior             | Real serializable write conflict retries successfully; retry limit enforced; ambiguous connection failure not automatically replayed                                                                                                           |
| Audit/outbox privacy       | Strict helpers reject arbitrary extra credential fields; stored envelopes verify against their checksums; all events remain pending with zero delivery attempts                                                                                |
| Decimal/canonical JSON     | Exact decimal-string calculations, explicit alternative rounding modes, invalid-number rejection and deterministic bounded request/event hashing                                                                                               |
| Dump/restore               | Read-only backup-account dump restored into a temporary database; installation, terminal, audit/event IDs, number allocations and idempotency results match source records                                                                     |
| Monitoring                 | Database/outbox bytes and pending count/age measured; configured disk warning exercised; absent disk path remains unknown rather than healthy                                                                                                  |
| Browser/server             | Built Express assets work with restricted runtime credentials on desktop/mobile; navigation/forms, loading/error/recovery, guarded routes and API 404s pass                                                                                    |

Sale/payment/movement/balance tables in the atomicity tests exist **only in the test database**. These tests prove the common transaction mechanism, not a completed POS, valuation or refund implementation. L5/L7 and later phases must add their own real-domain invariants and concurrency/rollback tests.

## CLI and measurement evidence

In a separate disposable database, the actual provision, migrate and bootstrap CLI entry points succeeded; bootstrap ran twice without creating a second installation. The storage CLI respected a supplied warning threshold. Temporary databases and their synthetic roles were removed after the smoke check.

A synthetic growth sample added **200 branch-registration events** (each with an audit entry): pending events increased **4 → 204**; total outbox relation/index storage increased **81,920 → 204,800 bytes**; total database storage increased **9,762,495 → 10,065,599 bytes**. No pending events were deleted. This measures small reference events and page/index allocation overhead; it is not a per-sale forecast or production capacity result. Use representative domain events and repeated monitoring during later qualification.

The CI workflow now installs PostgreSQL 18 dump/restore clients and runs the same test suite against its disposable service. Local pipeline results are observed; this phase's updated CI workflow has not yet been executed remotely.

## Operational limits

No customer/store data or credentials are committed. No user account or demo branch is seeded by production migrations. There is no cloud transport, event purge, production deployment, scheduled encrypted backup or timed hardware recovery in this phase. Storage monitoring emits local operator logs; supervision/rotation, actual backup destinations and store acceptance remain later work. The private L0 confirmations are preserved and are not replaced by generic fixtures.
