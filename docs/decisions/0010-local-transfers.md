# ADR 0010 — Local transfer quantity and value conservation

Date: 2026-10-02. Scope: L9 within one writable installation. Business-specific confirmations remain in ignored local records. This decision does not authorize independent branch databases or establish business acceptance of unresolved thresholds and discrepancy accounting.

## Decision

Use a versioned transfer aggregate with immutable submitted lines, product/unit snapshots, source/destination snapshots, append-only events, receipts, shipment valuation, discrepancy requests and transit entries. States are draft → pending → approved → in transit → partially received → received, with rejection/cancellation before dispatch. Received means all transit is accounted for; a document with losses or source returns is explicitly displayed as closed with discrepancy.

Every transfer requires an independent source reviewer and password confirmation. Approval reserves source availability. Dispatch consumes the reservation, deducts source sellable on-hand at its current moving weighted-average value and creates the transit value atomically. Reservations belong exclusively to their transfer. Both branches must be active for approval and dispatch. Product unit/fraction policy changes between drafting and approval require a new draft.

Destination receipts accept actual quantities at the shipment's value. They can split across time and stock conditions. Cumulative six-place allocations distribute rounding residue so the entire shipment value is consumed exactly, including receipts, losses and returns to source. A deferred database constraint and the `transfer_conservation` view check quantity/value against source/destination/return inventory movements. Normal inventory reconciliation also remains required.

Discrepancy requests bind exact quantities, disposition and values to a transfer version. They leave transit untouched until another authorized destination reviewer confirms with their password. Later activity invalidates the proposal. Return-to-source resolutions additionally require source resolution rights and restore dispatched value in the selected condition. Loss resolutions create an explicit operational loss record without pretending stock was received. Damaged/quarantined actual receipts preserve inventory value, with no automatic impairment policy.

Received sellable goods can travel back through a new transfer linked to the original, with reversed branches and a cumulative original-receipt quantity cap. Parent locking serializes competing return approvals. Each new dispatch uses its source's moving average, which may have changed since the original receipt; this avoids fabricating lot valuation. A return does not reopen or rewrite its parent.

All writes are transactional, version-checked and idempotent by installation, operation and request key, with actor/branch/content binding. Shared authorization locks protect review against simultaneous revocation. Stock writers use consistent lock ordering and existing count-freeze checks. Password confirmation must finish its exact action within five minutes and is consumed immediately; no reusable review token or threshold exemption is exposed. The browser persists exact pending requests before transmission, scoped to user and branch, excluding passwords. Known validation/conflict failures allow correction; uncertain results retain recovery state.

## Consequences and limits

Source and destination permissions are distinct. Archived products already dispatched can finish receipt/resolution using original fractional rules. Approval and dispatch to inactive branches are blocked; author cancellation can still release a reservation when the destination becomes inactive. Posted financial records remain immutable; there is no post-dispatch cancellation, ordinary backdating or independent-installation fallback.

Schema 9 extends existing manual reservations with a nullable transfer-item link and preserves populated schema-8 data. Deploy matching application/schema versions with the migration credential and normal backup/maintenance procedure. Review customized role grants; physical slips, two-person staffing, damaged-stock/loss policy, thresholds and network topology remain business/operational acceptance work. General reporting is L10; loss records here are not general-ledger journals.

See the [operator runbook](../runbooks/transfers.md) and [verification evidence](../acceptance/l9-verification.md).
