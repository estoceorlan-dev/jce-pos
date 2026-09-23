# L5 inventory verification

Date: 2026-09-23. Local Windows verification with Node 24.21.0, PostgreSQL 18 and a dedicated disposable `jce_pos_test` database. Synthetic data only. This records implementation evidence, not acceptance of real opening stock or a production release.

## Delivered

- Schema 5: branch/variant/condition balances, immutable movements, reviewed stock documents and items, scoped counts, reservations and immutable reservation events. Existing migration checksums remain unchanged.
- Versioned opening, adjustment, count and reconciliation documents; independent password-confirmed approval/posting, non-recycled numbers, idempotent retry, atomic audit and typed local outbox events.
- Branch stock screen with availability, low/out/damaged/quarantined filters, movement source links, CSV opening import, review/edit/cancel, reservation allocation/release, reconciliation and downloadable document reports.
- Read-only `inventory:reconcile` command, shared request contracts, OpenAPI endpoints, inventory permission grants, unit-policy protection after stock history, and operator/implementation documentation.

## Automated evidence

`npm run verify:release` covers formatting/lint, strict TypeScript, unit tests, PostgreSQL integration, production build and Chromium desktop/mobile journeys.

The inventory integration tests exercise:

1. Dated valued opening import with multiple stock conditions, retained manifest/checksum, independent approver enforcement, concurrent duplicate posting and identical retry recovery.
2. Branch/object isolation, permission/CSRF checks, failed password confirmation and immutable posted documents/movements/items, including attempts to move posted items into another draft.
3. Weighted-average costing, reservation exclusion, idempotent release, quantity/value exhaustion and out-of-stock filtering.
4. Count freeze, blocked overlapping writes/reservations, versioned counted edits, variance posting and explicit cancellation/unfreeze.
5. Stale balance and draft conflicts, refreshed resubmission and all-or-nothing invalid CSV handling.
6. An injected late outbox failure rolling back stock, movements, document state, numbering, audit and idempotency; retry subsequently succeeds.
7. Two independent database transactions competing for the last unit, with exactly one successful deduction and a reconciled result.
8. Detection of deliberately corrupted cached balances without writes, blocked ordinary adjustments, and an independently reviewed repair preserving the source ledger.

Unit tests additionally verify six-place fractional costing, exact final value residue, reserved-stock protection and decimal/input bounds. Browser journeys create an opening draft, change to a separate reviewer account, approve it, download its report, allocate/release stock, follow movement source links and reconcile. They run at desktop and mobile sizes and assert that no external asset requests are made. Screenshots are produced under ignored `test-results/` for layout review.

Final `npm run verify:release` result: **passed**. ESLint/Prettier, strict type checks, **18 unit tests**, **37 PostgreSQL integration tests**, production shared/web/API builds, and **12 desktop/mobile browser tests** all passed. Desktop/mobile screenshots were inspected; numeric stock columns remain readable without splitting decimal values, and wide tables scroll within their containers.

The read-only CLI was also run with the restricted runtime role against the final synthetic browser fixture: **6 balances checked, all matched, no discrepancies, exit 0**. No real branch database or opening-stock import was used.

## Remaining acceptance

- Real SKU/unit examples, opening source manifests and approved quantity/value totals; owner review of workflows and role grants.
- Business treatment of damaged goods, landed costs and exceptional corrections; the implemented technical precision policy is documented in ADR 0006.
- Physical internet/LAN-loss rehearsals, actual stock count/cutover acceptance, installed Windows desktop/hardware tests and production-capacity qualification.
- Purchasing, checkout, returns and transfers are L6 onward. The last-unit test exercises the real shared stock boundary; it is not a completed checkout test.

See [inventory decisions](../decisions/0006-inventory-ledger.md) and the [inventory runbook](../runbooks/inventory.md).
