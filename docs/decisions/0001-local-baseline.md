# ADR 0001 — Local implementation baseline

Business-specific answers and confirmations are stored only in `.local/business-intake/`, which Git ignores. This shared document contains generic planning guidance; consult the local records before applying defaults or requesting an already-recorded decision.

Date: 2026-09-21. Technical baseline adopted for L1 under the instruction to proceed with L0–L1. Business rules below are proposals awaiting owner validation.

## Scope and runtime

Use a dedicated `jce-pos` Git repository, npm workspaces, TypeScript, React/Vite, Express 5 on Node 24, PostgreSQL 18 and a later Electron client. `jce-website` stays separate. One writable Windows host serves shared data and same-origin web assets to LAN tills. No per-till database, external login or cloud transport. Separate physical installations require the later synchronization release.

Include all local modules in the implementation plan. Exclude e-commerce, payment gateway processing, loyalty, customer credit, payroll and a general ledger. Manually recorded cash/card/e-wallet and purchase/refund history are included. L1 itself is a shell without transactions or authentication.

Pin Node **24.21.0**, npm **11.19.0** and exact direct dependencies with one root lockfile. The isolated Node runtime archive was checked against the official SHA-256 list. React 19.3.0, Vite 8.3.0 and Express 5 are verified together by build/browser checks. Sources: [Vite setup](https://vite.dev/guide/), [Express installation](https://expressjs.com/en/starter/installing/), [official Node distribution](https://nodejs.org/dist/v24.21.0/).

Zod contracts, React Router, TanStack Query and React Hook Form support the UI. The server owns calculations and authorization. Ordered SQL migrations use a transaction, advisory lock and checksums. L1 only introduces migration metadata; L2 owns domain tables. The server never auto-migrates and readiness requires exact migration compatibility. A separate migration credential is supported.

Express serves the production build without Vite. Default bind is loopback. LAN HTTPS, service supervision, log rotation and Windows installation arrive in L11. Electron packaging, account bootstrap and demo seeds fail explicitly with the milestone still needed. No fake account/session is introduced.

## Proposed operating rules

| Area              | Working default                                                                                                                                        | Evidence needed                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Currency/time     | PHP; UTC storage; Asia/Manila display; proposed midnight business-day cutoff                                                                           | Owner confirms cutoff/sample reports                            |
| Catalog           | Every SKU is a variant; explicit base-unit conversions                                                                                                 | Actual SKU/barcode/unit/pack/fractional examples                |
| Precision         | Decimal strings; PostgreSQL numeric; proposed 6 fractional digits for quantity/unit cost, centavos at settlement                                       | Validate precision before L2 schema                             |
| Rounding/discount | Decimal half-up per settled line; discounts before tax; order discount proportional to eligible value, residual centavos assigned in stable line order | Owner/accountant approves examples and exceptions               |
| Tax               | Explicit inclusive/exclusive/untaxed codes and historical snapshots; no assumed production rate                                                        | Applicable registration, receipt fields, rates and calculations |
| Tender            | Cash, manually confirmed card/e-wallet, split payments; applied amounts equal due; change from cash only                                               | Approved types/reference rules                                  |
| Cost              | Moving weighted average; sale cost snapshot; landed cost allocated by line value; no negative available stock                                          | Opening values and costing policy                               |
| Return            | Original sale allocations/cost, remaining eligible quantity/value; damaged returns enter damaged stock                                                 | Eligibility windows and refund tender policy                    |
| Transfer          | Reserve on approval; dispatch removes source stock into transit; receipt uses dispatch cost                                                            | Discrepancy/partial receipt policy                              |
| Availability      | Internet-independent; LAN/host failure blocks finalization and preserves uncertain request ID                                                          | Host/router UPS and spare host                                  |
| Recovery          | Proposed RPO ≤60 minutes and RTO ≤2 hours; encrypted separate-device backup                                                                            | Destination, key custodian and restore drill                    |
| Capacity          | Provisional 5 tills, 25,000 variants, 1 million sale lines                                                                                             | First-/third-year estimates                                     |
| Import            | Opening catalog/stock/value; historical sales excluded by default                                                                                      | Source files, totals and cutover date                           |

The 12% tax fixtures are illustrative arithmetic, not a determination of the store's applicable tax rules. No real receipts/accounting records were supplied; no regulatory approval is claimed. Store actual source references and approvals in the evidence register before releasing live behavior.

Proposed client qualification target: supported Windows 11 x64 and updated Edge/Chrome. The bundle targets Chromium 120+ syntax; this does not commit to supporting obsolete browsers. Exact supported builds must be recorded during qualification. Keyboard-wedge scanner and Windows-installed printer are planned; actual model, paper width, driver and drawer are unknown. Electron is selected/pinned in L11.

L2 owns decimal calculations, transactional primitives, idempotency, audit and local outbox. L3 owns Argon2id, persisted sessions, server permissions, branch scope and bootstrap. Shell permission names are preliminary, not a complete authorization system.
