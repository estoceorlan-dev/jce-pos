# L7 checkout, register and receipt verification

Date: 2026-09-28. Windows verification with Node 24.21.0, PostgreSQL 18 and the dedicated disposable `jce_pos_test` database. Only synthetic merchandise, people, tender references and financial data were used. This is implementation evidence, not owner/tax/hardware acceptance.

## Delivered

- Schema 7: register sessions/opening floats, versioned carts, expiring independent discount approvals, sales/lines/payments/cash effects and receipt-print events. A unique open-terminal constraint, immutable committed records and sale-total consistency checks protect posting.
- Barcode/search cart entry, quantities/customer/discount/tax review, saved/held/resumed/cancelled carts, split cash/card/e-wallet recording and expected change.
- Server revalidation of quote, permission, tax confirmation, enabled tenders, register, approval and available stock. Atomic sale/cost/customer/cash/stock/audit/outbox/idempotency writes use the existing inventory boundary.
- Persisted checkout UUID and exact request, lost-response lookup/retry, unique sale per cart, committed snapshot receipts, visible unconfirmed printing, operator-confirmed print/failure and reprint history.
- Branch transaction search, customer/inventory source links, shared contracts, OpenAPI and operator/decision documentation.

## Automated evidence

Unit fixtures cover line extension and inclusive/exclusive tax rounding, discount ordering, cash change versus applied cash, split tender, reference/method/overpayment rules and request precision.

PostgreSQL checks exercise:

1. Upgrade from schema 6 without inventing historical sales; runtime privileges and reconciliation through the full suite.
2. Concurrent opening retries and the one-open-session-per-terminal constraint, including multiple register records mapped to one terminal.
3. A reviewed pack sale with exact converted quantity, discount/tax/net totals, split cash/card/change, snapshotted cost, customer history and duplicate/mismatched-request prevention.
4. Two different till sessions concurrently selling the last unit; exactly one succeeds with no negative stock/value.
5. Branch/object isolation, required cashier/session ownership, permission/CSRF checks, invalid password and no self-approval.
6. Approval invalidation after edit, expiry, reviewer privilege revocation and changed source prices; hold/resume/cancel and stale version behavior.
7. Reservation/count-freeze protection, archived merchandise and a closed-register session; current tax confirmation, tax rates, customer status and tender policy are rechecked.
8. An injected late outbox failure rolling back sale/line/payment/cash, document number, stock, customer history, audit, outbox and retry records; the same request subsequently succeeds.
9. Immutable committed header/components, blocked late payment insertion, receipt snapshots surviving repricing, idempotent printing attempts, same-operator outcomes and failed/reprinted/confirmed history.
10. Shared authorization locking lets ordinary till transactions run concurrently while a direct permission change waits; identity/configuration writes keep exclusive authorization locking.

The desktop/mobile browser journey opens a register, scans a barcode, selects a customer, edits quantity/discount, holds/resumes, switches to a separate password-confirmed reviewer, records split payment, then deliberately drops a successful checkout response. Reload/retry recovers the same receipt. A simulated authentication failure during recovery retains the pending request. Simulated printer failure leaves the sale committed; reprinting and explicit paper confirmation retain four print-history records. Requests outside the local host are blocked, and the journey asserts no external requests and no screen overflow.

Final `npm run verify:release` result: **passed**. ESLint/Prettier, strict types, **23 unit tests**, **56 PostgreSQL integration tests**, shared/web/API production builds and **16 desktop/mobile browser tests** passed. Vite emitted a nonblocking main-chunk size advisory (505.48 kB minified, 150.50 kB gzip); production-capacity qualification remains open. Desktop/mobile history and receipt-print screenshots were inspected; receipt content remains readable and wide screen tables scroll inside their containers.

Read-only reconciliation using the restricted runtime credential against the final synthetic browser fixtures checked **18 inventory balances**, all matched, with no discrepancies and exit 0. The two committed sales totaled **PHP 403.20**, matching applied payments; their **PHP 203.20** combined cash effect matched the cash ledger, with no per-sale line/payment/cash discrepancies. No real store database or payment service was used.

## Remaining acceptance

- Actual invoice/receipt examples, required business fields/series, VAT/non-VAT mappings, line rounding/discount rules, tender references and change policy; role grants and reviewer coverage.
- Physical scanner/printer/paper behavior, browser and installed-desktop recovery rehearsals, true host/LAN/internet outages, realistic capacity and owner acceptance. Network interception in tests does not qualify physical infrastructure.
- L8 refunds/posted corrections/shift close, later transfers/reporting, Windows installation and backup/restore qualification. L7 does not claim a complete production trading-day workflow.

See [checkout decisions](../decisions/0008-checkout-and-receipts.md) and the [checkout runbook](../runbooks/checkout.md).
