# L6 purchasing and receiving verification

Date: 2026-09-24. Local Windows verification using Node 24.21.0, PostgreSQL 18 and the dedicated disposable `jce_pos_test` database. Synthetic data only; this is implementation evidence, not supplier-policy or production acceptance.

## Delivered

- Schema 6 adds purchase orders, immutable submitted terms, receipt/reversal documents and lines, order events, scoped permissions and inventory movement versions. Existing migration checksums remain unchanged.
- Independent password-confirmed order approval, rejection and remainder closure; author draft editing, submission and cancellation. Purchase orders never move stock.
- Approved-order partial receiving with immutable unit/cost/tax/discount snapshots, exact base-unit conversion, unique delivery references, cumulative centavo allocation and atomic quantity/value, weighted-average cost, history, audit, outbox and retry records.
- Linked full receipt reversal with independent review, exact original quantity/value/amounts, stock availability checks, subsequent-movement protection and preserved cumulative allocations. Posted originals remain immutable.
- Outstanding orders, receiving and supplier history, inventory source links, printable receiving snapshots, shared contracts, OpenAPI routes and operator documentation.

## Automated evidence

The release pipeline runs formatting/lint, strict TypeScript, unit tests, PostgreSQL integration, production builds and desktop/mobile browser journeys.

Purchasing integration checks cover:

1. Upgrade from schema 5 with existing valued stock and movements; no fabricated receiving history and continued reconciliation.
2. Pack conversion, discounted/taxed partial delivery, supplier totals, weighted-average stock value, concurrent same-key retries and mismatched retry rejection.
3. Branch/object isolation, permission and CSRF enforcement, failed password confirmation, no-self approval, stale drafts and invalid state transitions.
4. Excess rejection, independent drafts competing for remaining quantities, duplicate delivery references and immutable approved/posted source records.
5. Rejection, cancellation, reviewed remainder closure and rejection of a pending delivery after closure; reversing a closed order retains its closure.
6. Exact fractional-value reversal, duplicate reversal prevention, reserved-stock protection and blocked reversal after consumption even when stock is replenished in the same transaction.
7. Refresh of stale cumulative rounding allocations; later receipts in another stock condition must be reversed first to preserve supplier centavos.
8. Count-freeze enforcement and an injected late outbox failure rolling back receipt/order state, numbering, stock, audit and retry records; subsequent retry succeeds and the full stock ledger reconciles.

Unit fixtures cover inclusive/exclusive tax, discount and inventory-tax treatment, fractional conversion and partial-delivery allocation. Browser journeys create and submit an order, switch to a separate reviewer, approve it, receive a partial delivery, inspect amounts, request printing, perform a reviewed reversal, follow the original and inspect supplier history. Both viewport projects check local-only requests and screen overflow. Print screenshots use landscape paper width.

Final `npm run verify:release` result: **passed**. ESLint/Prettier, strict type checks, **20 unit tests**, **45 PostgreSQL integration tests**, production shared/web/API builds and **14 desktop/mobile browser tests** all passed. Desktop/mobile history and landscape print screenshots were inspected; tables remain readable and screen tables scroll inside their containers.

The read-only reconciliation CLI also passed using the restricted runtime role against the final synthetic browser fixtures: **12 balances checked, all matched, no discrepancies, exit 0**. No real branch database or supplier records were used.

## Remaining acceptance

- Owner review of role grants and workflows, actual supplier invoices and accepted tax/discount/rounding calculations.
- Explicit business policy for excess deliveries, freight/landed costs, supplier returns and corrections after consumption. Current excess receiving and unsafe automatic reversals are blocked.
- Real opening stock/value acceptance, physical printer/paper qualification, installed Windows desktop, outage rehearsals and production-capacity testing.
- Checkout, payment, returns and transfers begin in L7 onward. Synthetic consumption exercises the shared ledger boundary; it does not represent an implemented checkout.

See [purchasing decisions](../decisions/0007-purchasing-and-receiving.md) and the [purchasing runbook](../runbooks/purchasing.md).
