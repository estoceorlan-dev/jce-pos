# Purchasing and receiving

Run `npm run db:migrate` with the migration credential before starting schema-6 application code. Administrators/managers receive purchasing read/manage/approve/receive permissions; inventory staff receive read/manage/receive. Users also need branch membership. Review actual grants and independent reviewer coverage before live use.

## Order and review

1. Select the branch and open **Purchasing → New purchase order**. Search for an active supplier and product variants. Create missing supplier/catalog records through their existing screens first.
2. Enter ordered purchase-unit quantities and costs. The line shows how many base units each purchase unit represents. Specify discount rate and tax rate as ratios (`0.10` means 10%), whether cost includes tax, and whether tax belongs in inventory value. Have the reviewer check these terms against source documents.
3. Save the draft. Its author can edit the current version. Enter an action reason and choose **Submit order**. No stock changes yet.
4. A different authorized user opens the order, reviews its quantities/amounts, enters a reason and their password, then approves or rejects it. Submitted terms are fixed; make a new order for changed terms.

Use **Order status → outstanding** for approved/partially received orders. Authors may cancel drafts/submitted orders. A different reviewer can **Close unreceived remainder** with a reason/password. Closure keeps quantities and receiving history, and prevents additional receipt posting.

## Goods receipt

1. Open an approved order and choose **Receive delivery**. Enter supplier invoice reference, unique delivery reference and actual purchase-unit quantities. Leave undelivered lines at zero. Select sellable, damaged or quarantined condition for each included line.
2. Save and inspect the receiving draft. The server converts quantities and calculates amounts from approved terms. No stock changes until **Post goods receipt**.
3. The draft's author posts it. Order progress, supplier amounts, quantity/value ledger, audit and outbox commit together. The order becomes partially received or received based on posted quantities.
4. Print the committed receiving document. It includes source descriptions/units, quantities/conversions, condition, discounts, tax, supplier amounts, stock value and receiving user. Printing failure does not undo receiving; reopen the receipt and print again.

Partial receipts may reuse an invoice reference, but each physical posting needs a distinct delivery reference. A reference already used by a posted receipt cannot be reused, even after reversal. To split one order line across conditions, use separately identified condition postings (for example a delivery reference with documented condition suffixes); do not record the entire delivery quantity in each posting.

Excess receipts are rejected. Get a separate approved order for additional goods. A count freeze blocks receiving for counted variants until that count is posted/cancelled. If another delivery changes centavo allocation, edit/refresh the receiving draft and inspect its revised values before posting. Archived supplier/product/unit records must be reviewed/reactivated before normal receiving.

Posting retries retain the same key in the browser tab and return the original result. If a draft-creation response is lost after leaving/reloading the form, inspect history before making a new draft. Drafts alone cannot duplicate stock. The delivery-reference constraint also protects against accidentally posting a second draft of the same delivery with another request key.

## Correction and reversal

Open the posted receipt, enter a reason and select **Request full reversal**. A different authorized user reviews the linked reversal and confirms their password. The original receipt stays posted and immutable; the reversal has its own number and negative financial/value amounts. Its positive displayed quantities are the units removed from stock. Supplier totals include both documents.

Automatic reversal is allowed only while no later stock movement exists on the affected balances and enough unreserved quantity/value remains. Later receipts on the same order line must be reversed first, including receipts into another stock condition, to preserve rounding allocations. Existing reservations may need authorized release. After any subsequent consumption or movement, the application blocks reversal: retain the original documents and escalate for a reviewed correction procedure. Do not change database rows, invent quantities, or enter a negative receipt. Partial reversals, supplier returns and cost corrections after consumption require additional approved policies.

Successful reversal reopens receiving capacity on an open order. Use a new delivery reference for a corrected receipt. A manually closed order remains closed after reversal.

## History and reconciliation

**Receiving history** includes draft, posted and cancelled documents; totals include posted receipts and linked reversals only. **Suppliers → Purchase history** filters by supplier. The order view links to its receiving history. Inventory movements link to their receiving source document.

Run **Inventory → Reconciliation** or `npm run inventory:reconcile` after qualification fixtures or suspected discrepancies. Purchase totals must also match the approved quantities and retained source invoices; a matched stock ledger alone does not validate supplier/tax input. These screens record purchasing activity, not supplier payments or a full accounting ledger.
