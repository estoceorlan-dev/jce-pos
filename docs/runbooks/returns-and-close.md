# Returns and daily close

Use **Returns & daily close** after opening a register through Checkout. The page lists your shifts; authorized reviewers can inspect assigned-branch shifts and requests. Requests remain under their original cashier.

## Return or reverse a sale

1. Open your current register shift, find the original receipt by number/customer and choose **Select for return**. Inspect original and prior return records.
2. Enter eligible quantities and choose sellable, damaged or quarantined disposition. Select a reason code and explain the return. **Full posted-sale reversal** is available only for the entire original sale with no earlier return.
3. Choose **Calculate refund**. Enter exactly the calculated amount across original tender methods. Noncash needs the confirmed external refund reference; the POS does not send it to a bank/provider.
4. Choose **Prepare return request**. A different manager opens the same request, checks quantities, condition, original allocations and refund tenders, and confirms their password with **Approve exact request**.
5. The requesting cashier opens the request and chooses **Post reviewed request** within five minutes. Posting records the refund and stock once. The original receipt remains available, with linked returns and reversals.

If approval expires, have the manager review again. If eligibility changed, prepare a new request for the remaining quantity. A prior partial return prevents full reversal; it does not prevent returning the remaining eligible units. Unlinked returns and tender substitutions beyond original method limits are not available.

## Cash and closing counts

1. Open the shift summary to compare opening float, cash received, applied payments, change, refunds and expected tenders. Record paid-in, paid-out or safe-drop entries with a reason. Paid-out/drop requests need a different manager's password-confirmed review before the cashier posts them.
2. Finish or discard active and held carts. Count cash physically and reconcile manually recorded card/e-wallet totals with provider records. Noncash counts are signed net totals; enter a negative amount when refunds exceed sales in this shift.
3. Enter **Counted cash/card/ewallet** and a close explanation. **Prepare closing count** stores a reviewable snapshot; it does not close immediately.
4. A different authorized manager reviews and approves the exact expected/count values. The cashier posts the reviewed request. New activity before posting requires a fresh close request and review.
5. Verify the **Reviewed closing count** and over/short values. Close every till individually. A shift stays assigned to its opening Manila date even if it crosses midnight. Closed shifts cannot reopen; subsequent work requires a new open shift. Later-sale corrections retain original receipt links.

Expected cash = float + cash received − change − cash refunds + paid-in − paid-out − safe drops. Expected noncash = applied payments − refunds. Net sales and net payments are shown separately from the cash drawer calculation. Manager acceptance of a variance does not create a general-ledger write-off.

## Interrupted requests

The page stores a pending creation request on this workstation before sending it. If its result is uncertain, use **Retry saved request**, including after reload. Do not create another request or clear storage to bypass uncertainty. For posting, reopen the same persistent request and retry; a committed request displays **Posted once**. Request identity prevents duplicate financial/stock effects even when a new network attempt is made. If stock is frozen for a count, finish that count first, then obtain fresh approval if needed.

Approval permissions are explicit: `returns.use`, `returns.approve`, `register.close`, `cash.approve`, plus checkout and sales access for the workstation screens. Two users are required for reviewed operations. Confirm staffing, return windows, provider procedure, close roles and cutoff with the business before live use.
