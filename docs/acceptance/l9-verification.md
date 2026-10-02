# L9 local branch transfer verification

Date: 2026-10-02. Verification uses synthetic users, branches, merchandise and values on a disposable loopback PostgreSQL 18.3 database with Node 24.21.0/npm 11.19.0. No store stock or production database is used.

## Delivered

- Schema 9 transfer lifecycle, reservations, shipment valuation, immutable receipts, independently reviewed discrepancies, linked returns, audit/outbox events and restricted runtime grants.
- Source/destination permission enforcement, exact-action review, stale-version rejection, duplicate/retry protection, count freezes and atomic rollback.
- Searchable branch-scoped transfer UI, draft editing, actual partial receipts by condition, discrepancy quotes, linked returns, user/branch-scoped lost-response recovery and printable slips/history.
- OpenAPI, [ADR 0010](../decisions/0010-local-transfers.md) and the [transfer runbook](../runbooks/transfers.md). The UI explicitly says independent-installation transfers are unavailable.

## Verification scope

Contract tests reject zero/negative/excess-precision and duplicate lines, distinguish receipts from explicit resolutions and require review version/reason/password. PostgreSQL tests upgrade populated schema 8 including a manual reservation, then cover independent approval, competing reservations, protected release, dispatch at current weighted cost, duplicate dispatch, partial receipt residue, damaged/quarantined and archived-product receipts, over-receiving, competing receipts, branch/line isolation, stale proposals, self-review denial, loss, source-return rights, linked-return caps, injected late failure rollback, count freezes, opposite-direction dispatch, inactive destinations and installation ownership.

Desktop/mobile browser journeys exercise a three-unit shipment worth PHP 30: one sellable receipt, one damaged receipt, and one independently reviewed missing unit. The first receipt's committed response is deliberately lost; reload/retry recovers one receipt. The sellable unit returns through a linked, independently approved transfer. Both transfer ledgers reconcile, source ends at 8 units/PHP 80, destination sellable at zero, destination damaged at 1 unit/PHP 10, and explicit loss is PHP 10. The browser checks print visibility, responsive layout and blocked external requests, and captures screen/print screenshots for local inspection.

Final results: ESLint/Prettier, strict TypeScript, **28 unit tests**, **76 PostgreSQL integration scenarios**, production shared/web/API builds and **18 desktop/mobile browser journeys** passed. The first integration run passed 75 scenarios but timed out during cleanup of an older foundation test's temporary database; that scenario passed on an isolated rerun without an application change. Browser verification initially found dropdown names unsuitable for exact label selection; explicit accessible names were added, then both transfer journeys and the complete browser suite passed. Screen and print screenshots were inspected locally; wide mobile tables scroll within their containers and do not widen the page. Actual paper output remains unqualified.

A final read-only reconciliation using the restricted runtime credential found **30 inventory balances and zero mismatches**, plus **four transfer lines with zero mismatches**. Combined transfer dispatch value was **PHP 80**, equal to **PHP 60 received + PHP 20 explicit losses**, with **zero remaining transit**. This includes two original shipments and their two linked returns across the desktop/mobile fixtures; these are movement totals, not net stock or revenue. The isolated test cluster was stopped after verification. Build output retains the existing nonblocking main-bundle size advisory; performance/capacity qualification remains L12.

## Remaining acceptance

Implementation verification is not business or production acceptance. Actual threshold exceptions, shortage authority, loss/damaged-goods valuation, two-person staffing, physical printer output, branch connectivity and independent database topology remain to be accepted. There is no cloud transfer transport, ordinary backdating or general-ledger posting. Reports, packaging, backup/restore, capacity qualification and pilot gates remain later milestones.
