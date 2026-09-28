# ADR 0008 — Checkout, registers and committed receipts

Date: 2026-09-28. Implements L7 on the L5 stock ledger and L6 receiving foundation. Private business confirmations remain in ignored local records. Actual receipt/tax examples, discount rules and tender/provider details still require business acceptance.

## Register and cart ownership

An authorized cashier opens a register session with an opening float. Partial unique indexes allow one open session per terminal and register. A session belongs to its opening cashier; cart creation and posting require that cashier, branch membership, an active register and an open session. Multiple registers on one terminal cannot bypass the limit. Register sessions retain their original register/terminal identity. Closing, refunds and cash movements are L8; L7 does not offer a close or bypass workflow.

Active and held carts belong to their cashier and original session. They store server-priced snapshots, customer identity and a version. Hold, resume, edit and cancellation increment the version. Held carts do not reserve stock. Draft cancellation has no stock/cash effect. Posted carts cannot be reused or edited, even with another checkout key. Reviewers can inspect another cashier's cart without acquiring ownership or the ability to post it.

## Money, tax and approval

PHP is settled at two decimal places. Quantities and base-unit conversions retain the six-place inventory policy. A variant's branch price applies to one variant unit; its snapshotted conversion determines the base units removed from stock. The technical calculation baseline rounds each price-times-quantity extension half-up, subtracts one explicit line discount, then extracts inclusive tax or adds exclusive tax. Net plus tax equals each settled line total; the sale sums those settled lines. Every sale must have a positive total. Zero-total giveaways, stacking, exemptions and manual price overrides are not inferred from the unresolved business policy.

Every positive manual discount requires a different authorized reviewer, password confirmation, a reason and an approval for the exact cart version and quote. Approval expires after five minutes. Editing or hold/resume invalidates it. Posting rechecks current reviewer and cashier eligibility, expiry, source prices, tax/product/customer status, business/branch settings and stock. The configured discount threshold does not waive two-person approval while business exceptions remain unresolved.

Business settings must be complete and `taxConfirmed` must be true before saving/posting carts. Branch tender settings must be present. This configuration gate is not a tax-compliance certification. No-tax variants remain explicit `NO_TAX` snapshots; actual merchandise tax mapping must be accepted before live use.

Cash, manually recorded card and e-wallet may be combined, with at most one allocation per method. Noncash requires a reference and cannot exceed the sale total. Cash must cover the remaining amount; change can only come from cash. Redundant cash when noncash covers the whole sale is rejected. Cash drawer effect is cash applied after change, not the amount handed over. The UI does not process or verify an external payment. No credit/accounts-receivable sale is enabled.

## Transaction and recovery

Read endpoints and inventory/purchasing/checkout/sales operations acquire the existing authorization lock in shared mode, so independent tills can progress together. Identity, permissions, master-data and settings writes retain its exclusive mode; authorization-table triggers also take the exclusive lock for direct SQL changes. This keeps permissions and source configuration stable for each posting without serializing all ordinary operations. Posting then locks cart, register session and all stock scopes in deterministic order. It validates the current quote against the saved quote, acquires any required discount approval, deducts available sellable stock at moving weighted-average cost, and atomically records:

- Immutable sale, line/cost/tax/customer/business snapshots and payments;
- The net cash effect, customer history, stock/value movements and balances;
- The finalized cart, document number, audit, typed local outbox and exact idempotent response.

The sale transitions from an internal draft to posted in that same transaction. Database constraints prevent an incomplete sale from committing, validate line/payment/cash totals at posting, reject header changes, and prevent extra lines/payments from being appended to a committed sale. Stock freezes, reservations, damaged/quarantined exclusions and ledger reconciliation remain enforced by the shared L5 boundary.

Before sending, the browser stores the checkout UUID and exact cart version/payments in local storage scoped by cashier and branch. A transport/server failure keeps that request across reloads and blocks another checkout in that screen until recovery. Lookup returns the original cashier's committed sale or null. Null can mean an in-flight request and never authorizes a new key; retry the same payload. Authentication, permission, throttling and idempotency-key conflicts retain the pending request. A definite validation/stock/state rejection lets the cashier correct the draft. The unique sale-per-cart rule is a second guard against duplicate sales from another tab or key.

Cart edits before saving are local form state. Saved/held carts are server records. Losing an unsaved cart is different from an uncertain final checkout. Local-storage failure prevents sending checkout rather than sending without a recovery key. Clearing browser storage removes the local recovery pointer; the original posted cart and transaction history still identify the sale.

## Receipt lifecycle

Receipt lookup and reprint use only committed snapshots. Receipt-print history appends a request and a separate operator-confirmed success or failure linked to that attempt. A browser print-dialog return does not prove paper printed. An interrupted/unconfirmed print remains visibly unresolved; printer failure never reverses the sale. Reprints retain the original number and financial data.

The shared UI supplies a narrow 58/80 mm content layout within browser printing. Physical printers, actual paper size, BIR/business fields and numbering acceptance are qualified separately, with hardware work in L11. Cloud transport remains disabled; local checkout requires the branch host/LAN but no internet assets or payment gateway.
