# L0 evidence checklist

This shared checklist intentionally omits business-specific answers, hardware inventories, personnel, schedules and approval records. The local evidence register and authoritative intake are kept in Git-ignored `.local/business-intake/docs/`. Consult them before asking the owner to repeat an answer.

| Evidence category             | Record privately                                                                                    | Required before                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Business and branches         | Identity, addresses, launch scope and physical checkout/connection model                            | Branch setup and deployment design             |
| Capacity and schedule         | Tills, SKUs, transactions, growth and target dates                                                  | Load qualification and cutover                 |
| Business source records       | Receipts, price lists, purchases, returns, counts, transfers and SKU/unit examples                  | Domain rule and fixture acceptance             |
| Import                        | Scope, source files/templates, opening values and reconciliation totals                             | Import and cutover acceptance                  |
| Hardware and network          | Actual OS builds, CPU/storage/RAM, PCs, router, connection quality, peripherals and drawer          | Installation and physical-device qualification |
| Recovery                      | Backup destination, power protection, recovery host, named custodians, objectives and drill results | Recovery qualification                         |
| Tax and receipt configuration | Applicable treatment, price inclusivity, fields, numbering and reviewed examples                    | Live receipt use                               |
| Money and inventory rules     | Discounts, rounding, tenders, costs, returns and discrepancy treatment                              | Relevant domain calculations                   |
| Permissions and approvals     | Role grants, branch scope, thresholds, exceptions, approver coverage and validity                   | Authorization acceptance                       |
| Business-day close            | Cutoff, authority and correction procedures                                                         | Closing workflow acceptance                    |
| Fixture review                | Named reviewer, accepted revision, date and exceptions                                              | Calculation acceptance                         |

Public planning documents and synthetic fixtures do not prove business approval. Keep source records and actual acceptance status in the private local record. An answer previously confirmed there remains valid even though it is omitted here.

Do not copy private answers back into tracked Markdown, fixtures, issues or commit messages. The local directory is excluded from normal Git staging/uploads; maintain its backup separately if needed.
