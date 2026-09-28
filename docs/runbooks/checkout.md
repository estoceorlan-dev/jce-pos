# Checkout, register opening and receipts

Apply schema 7 with `npm run db:migrate` using the migration credential before starting the matching application. Administrators/managers receive `checkout.use`, `checkout.approve` and `sales.read`; cashiers receive use/read. All operations also require branch membership. Inventory staff do not receive checkout rights by default.

## Setup

Complete business/branch settings, confirm accepted tax configuration, configure enabled tenders and receipt series, and create a terminal/register. Create branch prices and tax mappings for saleable variants, then post reconciled opening stock or goods receipts. Do not mark actual tax configuration accepted on the strength of synthetic tests.

Open **Checkout → Open a register with float**, select the register and record counted opening cash. Each terminal has only one open register session. Select your own open session for a new cart. Expected cash shown here is opening float plus applied cash sales; closing counts, payouts/refunds and daily reconciliation arrive in L8.

## Selling

1. Choose **New cart**. The scanner/search field receives keyboard focus. Scan an exact barcode and press Enter, or search and choose a product. Repeated scans add one variant unit. Check quantity and base-unit policy; the approved catalog conversion controls stock deduction.
2. Select a customer or leave walk-in. Enter any requested line discount as a PHP amount. Choose **Save and review cart** to calculate server prices and taxes.
3. Inspect quantity, price, discount, tax and total. **Edit cart** refreshes prices and invalidates old approval. **Hold cart** retains the draft without reserving stock; **Resume cart** returns it to review. **Cancel draft cart** discards an unposted cart only.
4. For a manual discount, a separate manager opens the saved cart under their own account, enters a reason/password and approves the exact discount. The cashier refreshes review. Approval lasts five minutes; edits, holding/resuming and source changes require review again.
5. Enter cash handed over and/or separately verified card/e-wallet amounts and references. Use **Add split payment** for another method. Noncash cannot exceed the sale total; only cash can produce change. Check expected change and choose **Complete sale**.
6. A committed receipt opens with the final change and printing state. Available stock, price/tax/settings and permissions are rechecked at posting. If a conflict appears, correct/review the draft rather than entering an unauthorized override.

## Lost response or connection

The workstation saves the final checkout request before sending it. If its result is uncertain, keep the saved request. **Check saved checkout** opens a committed sale if found; otherwise **Retry saved checkout** resends the exact request and returns the same sale if it already committed. A not-found lookup can mean the original is still running. Do not create a replacement checkout UUID or clear browser storage to bypass recovery.

After session expiry or a temporary permission/connection failure, sign back in with the original cashier and branch and recover the saved checkout. Another cashier cannot recover that user's key through the lookup endpoint. A posted cart links to its receipt, and **Transactions & receipts** can search receipt number/customer if the local pointer was lost. Never infer that a sale failed just because no receipt printed.

Internet loss alone leaves the local host usable. Host/LAN loss prevents finalization and activates recovery; a till does not maintain an independent posting database. Unsaved edits are browser form state; use saved/held carts to retain a draft.

## Print and history

Open the committed receipt and choose **Print receipt**. If paper printed, choose **Confirm paper printed**; otherwise **Record printing failed**. If the browser or printer fails, reopen that receipt and **Reprint receipt**. The original number/amounts remain unchanged, and each attempt stays in history. The application does not automatically treat a dismissed print dialog as success.

**Transactions & receipts → Printing not confirmed** shows unresolved receipts. Receipt details contain the committed customer/business, line tax/discount, payments, change and print history. Customer history and inventory movements link to the originating sale. Actual printer/paper/driver qualification remains L11.

After synthetic verification or a suspected discrepancy, run `npm run inventory:reconcile`. For cash, compare each session's opening entry plus sale cash effects; do not sum cash handed over without subtracting change. Posted voids/returns and shift closing require L8, so this milestone alone is not a production-ready full trading day.
