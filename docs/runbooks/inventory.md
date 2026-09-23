# Inventory and stock control

Apply migration 0005 with the migration credential before starting schema-5 application code. Existing balances are not fabricated. The migration adds inventory permissions: administrators/managers receive read, manage, approve and reserve; inventory staff receive read, manage and reserve. Cashiers do not receive inventory administration. Review actual role grants and branch assignments before use.

## Opening stock

1. Sign in, select the branch, and open **Inventory**. Check SKUs, base units and fractional policy against the source records.
2. Choose **Import opening stock**. Paste a CSV containing `sku,condition,quantity,unitCost`. Conditions are `sellable`, `damaged` or `quarantined`; quantities and costs use decimal strings with up to six fractional places. Use at most 100 lines per manifest. Keep all conditions of one SKU in the same document.
3. Enter a source reference, opening date and review notes. **Validate and create opening draft** validates every row without posting stock. Retain the original file with your cutover records; the application stores the normalized manifest and checksum.
4. Review the before/change/after quantity and value report. A different authorized reviewer signs in, opens **Documents → Review document**, confirms their password, and selects **Approve and post**.
5. Download the document's reconciliation CSV and run **Reconciliation**. Compare against physical source totals. Successful technical reconciliation is not owner acceptance of the opening values.

Opening documents are dated for source evidence, while their stock ledger is timestamped when actually posted. A variant with any existing branch movement cannot receive another opening document. Use a reviewed linked correction for mistakes after posting.

## Adjustments and counts

Search the stock list and choose **Add to document** for each affected item. Select the document kind, condition, reason and base-unit quantity. Adjustments use signed changes; counts use absolute counted totals. Additions require an explicit unit cost (zero is permitted for genuinely zero-valued stock). Deductions use current weighted-average cost. Use a linked original document and `CORRECTION` reason for a posted mistake.

To count, save the selected scope as a **count** draft before physically counting. Its variants are frozen across all conditions. Enter physical results with **Edit / refresh draft**, save, then have another authorized user post. Counts can freeze a subset of variants while other stock remains operational. Cancel a count explicitly to abandon it and release the freeze. A count below reserved quantity must be resolved by cancelling the count, reviewing/releasing reservations and starting a new count; do not invent stock to make it pass.

If stock changed after an ordinary adjustment draft was saved, posting fails. The original author must refresh/edit the draft and submit its new version for review. A saved draft does not reserve stock. Final documents are immutable. Reservation release and posting retries retain their request key in the browser tab; a retry of a successful action returns its original result. If a draft creation response is lost after leaving/reloading the form, inspect **Documents** before creating another draft. No draft changes on-hand stock.

## Availability, reservations and movement history

The stock table shows sellable on-hand, reserved, available, damaged, quarantined, weighted cost, total value and count freeze. Filters show low, out-of-stock, damaged and quarantined items; low/out use sellable availability. Movement history links to the originating stock document. Stock screens include archived variants with inventory history so balances remain visible.

Use **Reserve** to allocate sellable stock with a reference. The **Reservations** view shows active/released records and supports full release. Damaged or quarantined stock cannot be reserved. Allocations and releases are audited and do not pretend goods moved. L9 will link reservations to the transfer lifecycle.

## Reconciliation and repair

Run **Reconciliation** from the inventory screen, or use the read-only operator command with the runtime connection in `.env`:

```powershell
npm run inventory:reconcile
```

Exit status is 0 for matched balances, 2 for discrepancies, and 1 for connection/check failure. The command checks the installation's branches and prints discrepancy totals; it never writes.

On a mismatch, ordinary writes to the affected balance stop. Investigate the source ledger and reservations. If the ledger is correct and a cached balance is wrong, choose **Draft reviewed correction**, record investigation notes, save, and have another authorized user review and post it. Preserve the before/after CSV with incident evidence. If physical stock differs, use a count or adjustment. If the ledger itself is invalid, escalate to the maintainer; do not edit ledger rows or bypass constraints.

Internet access is not required for these workflows. Physical WAN/LAN-loss operation, installed desktop acceptance and actual opening reconciliation remain acceptance work for later gates.
