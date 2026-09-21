# L3/L4 verification

Scope: authentication, access administration, branch/settings configuration, product/partner master data and staged catalog imports. All automated records are synthetic; private intake is still ignored.

## Evidence

Verified locally on 2026-09-22: lint/format, strict types, build and **55 tests passed** (16 unit, 29 PostgreSQL integration, 10 desktop/mobile browser journeys). The dedicated PostgreSQL 18 test cluster was used; the store database was not migrated or seeded.

The current verification command is `npm run verify:release`, using pinned Node 24 and a dedicated PostgreSQL 18 test cluster. It includes formatting/lint, strict TypeScript, unit tests, real PostgreSQL integration tests, a production build and desktop/mobile Chromium journeys. Browser setup resets the disposable database before starting the server, avoiding stale connections to recreated test roles.

Coverage includes:

- One-time administrator bootstrap, Argon2id hashes, opaque persisted sessions, secure-cookie enforcement, origin and CSRF rejection, lock/unlock/logout, idle and absolute expiry, password reset/change, account disable, branch reassignment and login throttling/history.
- Last-administrator preservation, manager privilege/branch escalation denial, immediate role permission revocation, unauthorized branch lists/exports, nested customer/terminal references, and contact-field read/write/export boundaries.
- Product/variant/barcode uniqueness, literal search and bounded queries, fractional-unit validation, optimistic edits, archive/reactivate, branch-specific decimal prices and immutable price/tax/settings history.
- CSV validation/preview/skip policy, concurrent replay returning one result, catalog changes between preview and commit, injected price-write failure rolling back all created data, successful retry, audit/outbox metadata and spreadsheet-safe contact exports.
- Browser branch switching, locking and sign-out; product creation, barcode search, pricing/history; customer creation/archive and walk-in; CSV preview/commit/replay and finding imported items. Desktop and mobile screenshots remain ignored test artifacts.
- Existing L2 restricted-role migration, transaction/idempotency/sequence concurrency, rollback and PostgreSQL dump/restore checks remain in the suite.

See the [operator runbook](../runbooks/accounts-and-catalog.md) and [technical decisions](../decisions/0005-identity-and-master-data.md).

## Remaining acceptance gates

- Owner approval of tax/BIR and receipt rules, exact role assignments and discount/financial approval policies remains private and pending. Configurable fields do not count as regulatory or owner acceptance.
- Real merchandise samples and actual scanner/printer hardware have not been supplied/qualified. CSV and barcode journeys currently use synthetic data and keyboard input.
- Customer history storage/read endpoints are ready, but posted sale/refund linkage must be exercised when L7/L8 implement those documents. Transaction/report branch authorization must also be repeated when those endpoints exist.
- The browser uses the UI intended for the future desktop shell. Electron packaging and branch switching in that packaged shell remain L11 work.
- HTTPS configuration and application enforcement are present; actual LAN certificate trust, host/service/firewall installation and store recovery are L11/L12 gates.
- No opening stock, checkout, financial approvals, cloud synchronization or real store cutover was performed.
