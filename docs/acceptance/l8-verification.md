# L8 returns and register reconciliation verification

Date: 2026-09-30. Windows development verification with Node 24.21.0, npm 11.19.0 and PostgreSQL 18.3. Tests use a separate disposable `jce_l8_test` cluster bound to loopback. All merchandise, users, references, refunds and counts are synthetic. No store database or payment provider was used.

## Delivered

- Schema 8: immutable correction requests and expiring approvals, original-sale return lines, refund tenders, cash movements, session business dates and reviewed closures; restricted runtime grants and append/transition/reconciliation constraints.
- Original receipt lookup with eligible quantities, partial/full returns and full posted-sale reversals, reason codes, independent password-confirmed review and stock disposition.
- Original allocated discount/net/tax/cost, fractional-quantity validation, remaining original tender limits, archived-product returns and customer refund history.
- Cash paid-in/out and safe drops, expected/actual cash and signed noncash reconciliation, over/short review and immutable shift close. Later corrections use a new open shift with original links.
- Cashier/manager browser screens, persisted request creation recovery, retry-safe posting, source links, OpenAPI, decision record and operator runbook.

## Automated evidence

Unit tests cover cumulative centavo and six-place cost allocation, fractional returns, rounding residue and excess-quantity rejection.

The PostgreSQL checkout suite verifies populated schema-7 sales survive migration to schema 8 unchanged and existing shift business dates derive from original Manila opening dates. Eight L8 scenarios cover:

1. Damaged partial returns, original receipt preservation, duplicate posting and full-reversal rejection after a partial return; remaining eligible units still return exactly once.
2. Quarantined returns after catalog archive/repricing, separate cash/card refunds, original method limits, customer history and prevention of extra payments appended to posted returns.
3. Different tills concurrently refunding the same remaining unit: exactly one succeeds; stock and money reconcile.
4. Guessed branch/request IDs, request ownership, reviewer permission revocation and expiry, plus an injected late audit failure rolling back financial and inventory effects before a successful retry.
5. Full posted-sale reversal restores original stock/value once without changing the original receipt.
6. Float, cash sale, refund, paid-in/out and safe-drop reconciliation, manager-reviewed shortage, duplicate close, late transaction rejection and database prevention of reopening.
7. Active/held carts prevent close; new cash activity invalidates an already reviewed closing count.
8. A noncash sale in a closed shift is refunded in a new shift; negative net card counts reconcile, the old closure stays unchanged, identical concurrent creation requests recover the same ID, and changed-payload key reuse fails.

The desktop/mobile checkout journey continues through original-sale lookup, a damaged partial refund with original discounted/taxed allocation, a different password-confirmed reviewer, lost committed-refund response and reload recovery, then reviewed shift close. Final fixture counts are PHP 500.80 cash and PHP 100.00 card per shift, with zero variance. External requests remain blocked and the page stays within the viewport; wider tables scroll inside their containers. Desktop/mobile close screenshots are produced in ignored Playwright test results and inspected locally.

Verification comprises ESLint/Prettier, strict TypeScript, **25 unit tests**, **64 PostgreSQL integration tests**, production shared/web/API builds and **16 desktop/mobile browser journeys**. Browser journeys use two workers; the unconstrained six-worker run exceeded the five-second sign-in assertions on this development host. The configured functional suite does not qualify production capacity. Vite reports a nonblocking main-bundle size advisory (about 520 kB minified); production-capacity qualification remains L12. Check results are recorded for this working tree, not as production acceptance.

Final results: all checks above passed, with the browser suite rerun after setting its worker bound. A read-only check using the restricted runtime credential found **18 inventory balances and zero mismatches**. Two sales totaled **PHP 403.20**, equal to applied sale payments; two returns totaled **PHP 201.60**, equal to refund payments. Both reviewed closures had zero cash/card/e-wallet variance. The isolated test database was stopped after verification.

## Migration and remaining acceptance

Deploy application/schema 8 together using the migration credential and normal backed-up maintenance procedure. Existing receipts and cash entries stay unchanged; the new business-date column is initialized from shift opening time. New permissions are granted to baseline administrator/manager roles, with return requests and close requests granted to cashiers. Review customized role grants and two-person staffing before deployment. This work applies migrations only to disposable test databases.

The provisional cutoff is Manila midnight with each shift attributed to its opening date. There is no reopening, ordinary backdating, unlinked return, branch-wide period freeze or external refund processing. Business acceptance of return windows, tender exceptions/provider procedure, cutoff, closing roles and variance treatment remains open. Actual printer/scanner/outage testing, transfers/reports, Windows packaging, backup/restore and owner acceptance remain later gates.

See [ADR 0009](../decisions/0009-returns-and-register-close.md) and the [returns/close runbook](../runbooks/returns-and-close.md).
