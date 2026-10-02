# Local branch transfers

Transfers move stock between branch records owned by one local installation. They do not coordinate independent databases. Both branches must be active before approval and dispatch. Quantities throughout this workflow are **base units**, with the product's fractional-quantity policy; entering a pack count does not apply a conversion.

## Prepare, review and dispatch

1. Select the source in **Active branch**, open **Branch transfers**, and choose **New transfer**. Select a destination, search/add products, enter base-unit quantities and a reason, then save the draft. Only its author can edit, submit or cancel it. Source, destination and original-return link cannot be changed after creation.
2. Inspect the draft and enter an action reason. **Submit for approval** freezes its product descriptions, units and requested quantities. A different source-branch reviewer signs in, opens the transfer, reviews its lines, enters their password and reason, then approves or rejects it. Every transfer requires review; no value/quantity threshold exemption is enabled.
3. Approval reserves available source stock. It does not deduct on-hand stock or add destination stock. Other sales and transfers cannot consume those reserved units. Transfer reservations cannot be manually released from Inventory.
4. An authorized source dispatcher enters a reason and chooses **Dispatch transfer** after physically handing over the goods. Dispatch atomically releases its reservations, deducts source on-hand and records quantity/value in transit. Value comes from moving average cost at dispatch, not draft or approval time. Print the transfer slip from the saved document.

Before dispatch, the author can cancel; cancellation releases any approval reservation. After dispatch, cancellation is unavailable. Use actual receipts, independently reviewed discrepancies or a linked return transfer. Do not create an unrelated stock adjustment to clear transfer transit.

## Receive actual goods

1. Select the destination branch and open the transfer (filter by number, inbound direction or status).
2. Enter only the quantities physically received; leave other lines at zero. Choose sellable, damaged or quarantined condition and enter a reason. Post the actual receipt. Each receipt has its own number, user, time, condition, quantity and value.
3. Receive additional portions as they arrive. To split one product across conditions, post a separate receipt for each condition. The server rejects quantities beyond the remaining shipment, duplicate lines and stale versions.

Short receipts leave remaining quantity/value in transit. Damaged/quarantined receipts preserve the assigned dispatch value in those inventory conditions; they are not write-offs. Products archived after dispatch can still be received against their shipment snapshot. Quantities and values reconcile on the slip; all values are PHP and stock values retain six decimal places. Times are shown in Asia/Manila.

## Resolve a discrepancy or return goods

Use **Propose discrepancy** only after investigating the remaining transit stock. Choose a reason code, exact quantities and either **Record loss** or **Return to source**. A proposal does not change stock or transit. Another destination reviewer inspects the displayed quantities and values, enters an action reason and their password, then confirms the resolution. The requester cannot approve their own proposal. A return-to-source resolution also requires that reviewer to have source-branch resolution permission, and should be confirmed only when the goods are physically back at source in the selected condition.

Record loss removes the reviewed quantity/value from transit with an explicit immutable discrepancy record. Return to source restores that quantity/value at source. A subsequent receipt or proposal makes an older pending proposal stale; request a new one against the current remaining stock. The final document shows **Closed with discrepancy** whenever loss or return-to-source consumed part of the shipment. It does not claim those units arrived at destination.

For sellable goods already received at destination, choose **Create linked return transfer**. Add the original received product and actual return quantity. The new source/destination are reversed, and the original number is linked. The return follows its own submit, independent approval, dispatch and receipt workflow. The server caps approved/dispatched returns by the original sellable receipts still eligible for return. The new shipment uses its source's current moving average cost; it is not an undo of the original receipt. Nested return-of-return documents are not supported.

## Recovery, access and history

- If a response is lost, reload and choose **Retry saved transfer action**. The browser retains the exact request under the signed-in user and branch; the server returns the committed result once. Do not clear browser storage or create a replacement action while its outcome is uncertain. A reviewed action asks for the password again; passwords are never stored in recovery data.
- The server checks branch side, permissions, original author/reviewer and version on every action. Source membership does not grant destination receiving rights. Current permissions are checked again during review. Confirmation and its action must complete within five minutes; an approval is consumed by its exact action, not reusable for another document.
- Inventory counts freeze affected products and can block approval, dispatch or receiving. Finish or cancel the stock count through its normal workflow before retrying.
- The slip includes original branch/product snapshots, quantity/value conservation, dispatch and receipt details, discrepancy proposals/reviewers, linked returns and action history. Browser printing is supported; actual paper/printer acceptance remains an operational gate.
- `transfers.read` allows branch-visible history. `transfers.manage`, `transfers.approve`, `transfers.dispatch`, `transfers.receive` and `transfers.resolve` are separate grants. Baseline administrators/managers receive all six; Inventory Staff receive read/manage/dispatch/receive. Review customized roles and actual two-person staffing before rollout.

No ordinary backdating, cross-installation transport, threshold exception, automatic damaged-stock revaluation or accounting journal is included. Loss values are operational inventory records. Confirm actual discrepancy policy, reviewer authority, damaged-goods treatment and physical branch topology before production acceptance.
