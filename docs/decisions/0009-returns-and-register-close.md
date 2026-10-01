# ADR 0009 — Returns and register close

Date: 2026-09-30. L8 builds on immutable L7 sales and the L5 stock ledger. Business-specific confirmations remain in ignored local records. Return windows, unlinked-return exceptions, tender-provider procedures, closing roles and monetary exceptions still need operational acceptance.

## Requests and authorization

Returns, cash movements and closing counts use immutable requests. Creating a request calculates and stores its exact input and quote. Changes require a new request. Requests do not move money or stock. The original cashier posts it in their open register session. Another active, branch-authorized user confirms their own password to approve refunds/reversals (`returns.approve`), withdrawals/safe drops and closes (`cash.approve`). All those actions require review; paid-in entries require normal checkout permission. Approvals bind the request, input and quote, expire after five minutes, and are checked again at posting, including current permission and expiry before commit. Passwords stay out of persisted requests, audit and outbox.

The terminal persists the exact request/key before creation. An uncertain creation is retried with that payload. Posting uses the existing request identity and key; a committed request returns the same ID on a retry, including after shift closure. Branch and author checks still apply. The immutable financial document and unique approval references are additional duplicate guards. Pending requests remain reviewable history; replacing a stale request does not authorize the old request against changed quantities or close totals.

## Original-sale returns

Only linked returns in the original branch are implemented. Original-sale lookup shows remaining eligible quantities and prior return documents. The register receiving the return can be a different open shift in that branch. A posted-sale reversal returns every original line in full and is prohibited after any partial return. After a partial return, use ordinary returns for the remaining eligible quantities. Discarding an unposted cart has no financial or stock effect.

For each original line and amount, allocation is `round(original × cumulative returned / original quantity) − round(original × prior returned / original quantity)`. Net, tax and discount use two places; cost uses six. Net plus tax determines the refund. This preserves the original discount/tax rules and assigns rounding residue across successive returns without exceeding the source. Free or fully discounted lines can have a zero refund and no tender. Base quantities use original conversion and fractional rules; subsequent price changes or catalog archival cannot prevent a correctly linked stock return.

Cash, card and e-wallet refund records are separate from original sale payments. Their sum must equal the calculated refund; each method is capped by its original applied amount less earlier refunds, and noncash needs a reference. References record the operator's confirmation, not gateway settlement. Original tender caps are a conservative implementation rule pending business acceptance of exceptions.

The original sale row serializes competing refunds. Posting locks the request, register, original sale and complete inventory scope, then atomically inserts return header/lines, tenders, stock/value movements, customer refund activity, document number, audit, local outbox and idempotent response. Sellable, damaged and quarantined dispositions all retain original allocated cost, while damaged/quarantined stock stays unavailable for sale. The original receipt remains unchanged and displays linked corrections separately.

## Register close and business dates

Each shift receives the Manila calendar date of its opening. Midnight is the provisional business-day boundary; a shift spanning midnight remains assigned to its opening date until closed. Later reports must join sale/return session business dates rather than infer a different cutoff from timestamps. There is no automatic midnight close or branch-wide posting freeze. Each till must close its own shift for end-of-day reconciliation; approved branch-wide period close and reporting are separate future work.

The cashier first posts or discards every active/held cart. The close request captures opening float, sales received/applied, change, refunds, paid-in, paid-out, safe drops, expected tenders and cashier counts. Cash expected is opening float plus cash applied after change, less cash refunds, plus paid-in, less paid-out and drops. Noncash expected is applied tenders less refunds. Sales less refunds is also compared separately to payments less refunds; float and cash movements never become sales revenue.

A different manager reviews the exact count and explanation, including a zero variance. Any new sale, refund or cash movement invalidates that close quote, even if offsetting transactions leave the same total. Posting freezes a closure with counts, expected values and signed over/short amounts, and locks the session against further writes. Closed sessions cannot reopen. Corrections use a new open session, current posting time and the original sale/request reference; no ordinary backdating or historical rewrite is available. Shortage handling is a reviewed variance record, not an automatic accounting write-off. Staffing, cutoff and exception policies remain business acceptance items.

## Database protection

Schema 8 adds correction requests/approvals, returns, refund tenders, cash movements and register closures. Runtime access allows append-only financial components and only the pending-to-posted request/open-to-closed register transitions. Components cannot be appended to posted requests, and deferred constraints reconcile returns with their original lines and refund payments. All transactional paths continue to use the existing authority lock, decimal arithmetic and inventory reconciliation boundary. Local outbox events contain metadata only; cloud transport remains disabled.
