# ADR 0002 — Workflows and approval proposal

Business-specific answers and confirmations are stored only in `.local/business-intake/`, which Git ignores. This shared document contains generic planning guidance; consult the local records before applying defaults or requesting an already-recorded decision.

Date: 2026-09-21. Proposed business rules; owner sign-off pending. Not implemented in L1.

## Permission matrix

Server authorization must check session, action and all branch/object references, including exports. UI visibility is convenience only. Administrator status does not permit rewriting financial history.

| Action                     | Administrator                    | Owner/manager         | Branch manager                  | Cashier              | Inventory staff                             |
| -------------------------- | -------------------------------- | --------------------- | ------------------------------- | -------------------- | ------------------------------------------- |
| Users/roles/installation   | Yes                              | Review                | No                              | No                   | No                                          |
| Tax/receipt configuration  | Configure with business approval | Approve               | View assigned branch            | No                   | No                                          |
| Catalog/suppliers/prices   | Explicit grant                   | Yes                   | Assigned branch                 | Read                 | Edit catalog; price approval needed         |
| Register/normal checkout   | Explicit grant                   | Yes                   | Yes                             | Assigned till/branch | No                                          |
| Discount/price override    | Explicit grant + approval        | Approve another actor | Approve within future threshold | Request              | No                                          |
| Refund/posted correction   | Explicit grant + approval        | Approve               | Approve within future threshold | Request              | No                                          |
| Receiving/count/adjustment | Explicit grant                   | Yes                   | Yes                             | No                   | Receive/draft; adjustments require approval |
| Transfer                   | Explicit grant                   | Approve               | Approve own branch              | No                   | Draft/dispatch/receive per assignment       |
| Reports/exports            | Explicit grant                   | Assigned branches     | Own branch                      | Own register         | Stock only                                  |
| Backup/restore/diagnostics | Yes, maintenance procedure       | Review                | Status                          | No                   | No                                          |

Thresholds are unknown. Proposed conservative default: a second person approves every manual discount, price override, refund, posted correction, stock adjustment, transfer discrepancy resolution and cash withdrawal. Normal sales, approved PO receipts and physical transfer receipts within expected quantities need normal permission only. Owner must resolve staffing/thresholds before release; self-approval is not implied.

## Approval binding

Approver must be a different active user with the branch/action permission and fresh credential verification. Approval binds actor, approver, branch, operation, document ID/version, reason and canonical hash of exact affected amounts, quantities and lines. Proposed expiry: five minutes. Draft edits, changed branch/version, permission change, revocation or expiry invalidate approval.

Consume approval once inside the posting transaction. Identical idempotent retries return the original result; approvals cannot be reused for a different operation. Record requested/approved/denied/consumed events without credentials or tokens. Approval is not a temporary reusable role switch.

## State and posting boundaries

| Document         | Transitions                                                                     | Corrections                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sale             | Draft/held → posting → posted; client may show uncertain pending reconciliation | Abandon drafts; immutable posted sale, linked return/reversal only                                          |
| Return           | Draft → awaiting approval → posted                                              | Lock/check original remaining quantities/refunds; linked compensating record                                |
| Purchase order   | Draft → approved → partially received → received/closed                         | Cancel unreceived remainder only                                                                            |
| Goods receipt    | Draft → posted                                                                  | Atomic quantity/value increase; linked approved adjustment/reversal                                         |
| Count/adjustment | Draft → reviewed/approved → posted                                              | Validate current version/balance; immutable movements                                                       |
| Transfer         | Draft → approved/reserved → dispatched → partially received → received/closed   | Pre-dispatch cancellation releases reservation; later shortages remain in transit until approved resolution |
| Register         | Open → reconciliation → closed                                                  | No posting to closed register; authorized variance record                                                   |

Posting recalculates server-side and atomically creates document, payments, movements/balances, audit and outbox. UUIDs identify records; locked non-recycled sequences identify documents. LAN failure requires idempotency reconciliation before another sale attempt. Proposed close rule: ordinary backdating into closed periods is forbidden; corrections post into an open period with original references. Owner must confirm close boundaries and return windows.
