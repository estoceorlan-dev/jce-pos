# ADR 0007 — Purchase orders and goods receiving

Date: 2026-09-24. Implements L6 on the L5 inventory boundary. Business-specific confirmations remain in ignored local intake records. Actual supplier documents, rounding acceptance, tax treatment, freight allocation and supplier-return rules remain acceptance items.

## Orders and authority

Orders follow `draft → submitted → approved → partially_received → received`. Authors can edit only their current draft version and can cancel a draft/submitted order. A different authorized reviewer confirms their password to approve/reject a submitted order or close an approved/partially received order's unreceived remainder. Final cancellation, rejection and closure are immutable. Submitted commercial terms and lines cannot be rewritten; database triggers also prevent resetting an approved order to draft.

Ordering creates no inventory movements or reservations. Order lines snapshot SKU, description, base unit, conversion, fractional policy, purchase-unit cost, discount rate, tax rate, tax-inclusive flag and explicit tax treatment for inventory valuation. Supplier/branch labels are snapshotted without contact information. Unit/conversion/fractional changes are blocked once purchase-order history references the variant.

## Receiving and amounts

Receipts require an approved, open order and positive quantities within its remaining approved quantities. Until a business exception policy is approved, over-receiving is rejected; extra goods require a separately approved order. Multiple partial receipts can reference the same supplier invoice. A unique delivery reference per supplier/branch prevents posting the same delivery under another request key. Reversing a receipt does not recycle that reference.

Quantity input is in purchase units. The server multiplies by the order's snapshotted conversion and requires an exact result within six base-unit decimal places and the variant's fractional policy. A receipt contains at most one entry per order line; separate condition postings need separately identifiable delivery references.

The server applies the line discount before tax. It separates inclusive tax or adds exclusive tax according to the order. Each order line explicitly chooses whether tax contributes to inventory value; no freight allocation is inferred. Supplier amounts use two decimal places; stock valuation uses six. Both use the technical half-up baseline, which remains subject to acceptance against actual supplier invoices.

Cumulative allocation prevents partial deliveries from duplicating rounding cents: the new receipt receives rounded amounts for cumulative quantity after receiving minus the amounts for cumulative quantity before receiving. Drafts whose allocations change must be refreshed before posting. Exact six-place document stock values go through the common inventory helper so division into base-unit cost cannot lose value. Weighted-average cost remains balance value divided by quantity. These are recorded supplier amounts, not evidence of payment or an accounts-payable ledger.

## Posting and reversal

Every mutation uses branch membership and action permissions. Posting/transition requests use installation/operation-scoped idempotency keys containing actor, branch, document and version; credentials are never persisted in their hashes. Reviewer authorization and the requesting user's current eligibility are checked again. Password-confirmed approvals are consumed in the same transaction and must finish within five minutes.

Lock order is purchase order, receipt, then all affected branch/variant stock locks in deterministic order. Posting commits receipt snapshots, signed financial amounts, stock/value movements, balances, order progress, numbering, audit, outbox and idempotency response together. Count freezes and reserved-stock checks are inherited from L5. Received quantities and supplier history derive from posted immutable receipt/reversal lines, rather than applying stock effects again.

A correction is a linked, full reversal draft reviewed by a different user. It preserves the original receipt, reverses its exact quantity/value/financial amounts, and permits a replacement receipt on the reopened order. Automatic reversal requires that each affected condition still has the original receipt as its latest stock movement and has enough unreserved quantity/value. New movement rows carry the resulting balance version so reversal checks do not depend on timestamp ordering. Reservation allocation/release does not itself count as a stock movement, but outstanding reservations still constrain availability.

After a sale, adjustment, later receiving or other subsequent movement, automatic reversal is blocked. Later receipts still posted on the same order line must also be reversed first, even across different stock conditions, to preserve cumulative rounding allocations. This deliberately avoids reversing old purchase cost through already-consumed weighted-average stock. Do not edit history or substitute a negative receipt; investigate and resolve the case under a separately reviewed correction policy. Supplier returns, partial receipt reversals and freight-cost corrections are not implicitly approved. A reversal against a manually closed order retains the closure; it does not authorize new receiving.

## Views and rollout

The UI provides order status/outstanding filters, author editing, independent review, partial receiving, source document links, supplier/order receiving history, signed totals, reversal review and printable receiving snapshots. Print output is an internal receiving document, not a tax-compliance certification. Migration 0006 adds purchasing tables/permissions and a nullable movement-version column while retaining L5 stock history. Cloud delivery remains disabled.
