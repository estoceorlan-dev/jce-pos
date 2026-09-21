# Accounts, branches and catalog

Business intake, hardware answers and owner confirmations remain only in ignored `.local/business-intake/`. Do not put them in seed scripts, test fixtures, screenshots committed to Git, or shared documentation.

## Upgrade and create the first account

Back up an existing installation and stop application writes before upgrading. Use the configured migration credential:

```powershell
npm run build:server
npm run db:migrate
npm run db:bootstrap
```

Migrations 0003/0004 add identity/master tables without rewriting migrations 0001/0002. `db:bootstrap` initializes the installation identity. Create `.local/admin.env` with the migration URL and **your own** credentials:

```dotenv
MIGRATION_DATABASE_URL=postgresql://jce_migrator:replace_me@127.0.0.1:5432/jce_pos
ADMIN_USERNAME=your.chosen.username
ADMIN_DISPLAY_NAME=Your chosen display name
ADMIN_PASSWORD=your-own-secret-of-at-least-12-characters
```

Run `npm run auth:bootstrap` once, then remove the password from the file. The command refuses if any users exist. Its administrator receives existing active branches. If no branches exist, sign in, create one under **Branches**, and sign in again after membership creation revokes the session. There is no default recovery password. Keep a second authorized administrator account available before staff onboarding.

## HTTPS and development

For `npm run dev`, use `.env.example` with `APP_ORIGIN=http://127.0.0.1:5173`, `HOST=127.0.0.1` and `ALLOW_INSECURE_LOOPBACK=true`. For a built development server change the origin to `http://127.0.0.1:3000`. Scheme, hostname and port must exactly match the browser address. `localhost` and `127.0.0.1` are different origins. Never enable HTTP exception mode for LAN clients.

For LAN/production set:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=https://pos.internal
ALLOW_INSECURE_LOOPBACK=false
```

Use an approved LAN DNS name in place of this generic example. Configure an HTTPS proxy on that host using [the Caddy example](../../deploy/Caddyfile.example). Caddy's [`tls internal`](https://caddyserver.com/docs/caddyfile/directives/tls) issues certificates from its local CA; install that CA's public root certificate in every client trust store. See [Caddy's local HTTPS/trust guidance](https://caddyserver.com/docs/automatic-https). Keep CA private keys protected, outside Git, and part of the later approved recovery process. Do not bypass certificate errors. Clients reach HTTPS port 443, not PostgreSQL or the loopback API port. Do not enable proxy access logs containing sensitive URLs/headers.

This supplies the application/proxy configuration. Installing Windows services, distributing/trusting certificates on actual tills, firewall verification, renewal/recovery and the packaged Electron client remain L11/L12 acceptance work. Automated tests exercise HTTPS enforcement and Secure cookies through trusted-proxy requests; they do not certify the store's physical LAN.

## Accounts and permissions

The first release includes these editable starting grants. They are technical defaults, pending owner approval of final personnel and authority assignments.

| Role                     | Starting access                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Administrator / Owner    | All implemented permissions; role itself is fixed                                                                         |
| Manager / Branch Manager | Catalog read, branch prices, partner CRUD/contact details, users within own authority, branch settings, own login history |
| Cashier                  | Catalog and partner names; no contact details or master-data writes                                                       |
| Inventory Staff          | Catalog read and partner CRUD without contact details                                                                     |

Use **Users & permissions** to create accounts, assign branches, disable accounts and edit non-admin role grants. Creating/resetting a user password forces a first-login change. Account/membership/password changes end the affected user's sessions. Only an administrator can reset passwords or change a role's granular grants. Role grants are global: changing a role affects every user holding it. A manager cannot grant a role with permissions or branch memberships they do not hold. The last active administrator cannot be disabled or demoted.

The branch switcher lists active assigned branches. Administrators must also hold branch membership for branch data. Global catalog management and business settings have separate permissions. **Lock** hides the workspace and blocks API work until password verification; **Sign out** revokes that session. Sessions expire after 30 minutes without work or eight hours total. Repeated login failures require a 15-minute wait. Administrators see login history for all users; permitted non-admins see their own.

## Settings and hardware records

Create branches, then assign users. Codes are permanent. Archive/reactivate through **Branches**; referenced history remains. **Terminals & registers** creates terminal identity and registers for the selected branch. An unrelated branch's terminal is rejected. A manual cash drawer needs no automatic drawer integration.

Enter confirmed identity, currency/timezone, receipt series/footer and tax confirmation in **Store settings**. Create owner-reviewed tax definitions in **Catalog setup**; no tax code or VAT rate is assumed. Branch settings capture allowed cash/manually recorded card/e-wallet tenders, discount threshold and printer preferences. Settings history shows prior values and Manila timestamps. These settings do not qualify BIR compliance, implement tender integrations or apply discounts: financial posting/approval logic and actual receipt printing come later. Leave unconfirmed business rules unapproved.

## Catalog and contacts

1. Create categories, brands and units in **Catalog setup**. Enable fractional base quantities only for units that permit them. Create approved tax codes when available.
2. Add a product with its first variant. Use **Add variant** to reuse a product grouping. SKU and barcode aliases must be unambiguous. Set the exact base-unit conversion and low-stock threshold; no stock is posted here.
3. Search by name/SKU or scan into the search field. Set a price for each branch that sells the variant. Prices without configuration remain blank. **Price history** preserves old values. Edits use versions and reject stale submissions; reload before retrying a conflict.
4. Archive a variant or definition to stop ordinary use; use the archived filter to reactivate it. Existing history is preserved.
5. Maintain branch-specific suppliers/customers. Contact fields and export columns require `contacts.read`. Staff without this permission may edit names while hidden contact details remain intact. Walk-in requires no saved customer. Posted customer sale/refund links begin with L7/L8; this milestone displays an empty history rather than invented transactions.

## CSV import and export

Download the template from **Catalog import**. Columns, in order:

```text
sku,product_name,variant_name,unit,conversion,fractional,minimum_stock,barcode,price
```

Each row creates a product and variant with one optional barcode and a price in the selected branch. The `unit` must exactly match an active unit name. Use a dot for decimals and `true`/`false` for fractional quantities. Retain barcodes as text to preserve leading zeros. Categories/brands/tax associations and additional variants/aliases can be edited after import. Opening quantities/values are intentionally absent; L5 posts opening stock through an approved document.

Choose **Reject duplicates** or **Skip existing or repeated codes**, preview, review all rows/errors, then **Commit reviewed import**. A file never overwrites an existing catalog record. Stages expire after one day and belong to their creator/branch. If the catalog changes after preview, restage the file when prompted. If the response is lost, retry the same stage's commit; it returns the original result without adding products twice. Keep private source files in `.local/`, `customer-data/` or another ignored directory.

Customer/supplier **Export current page** respects the active search/status/page and branch/contact permissions. Export subsequent pages separately if needed. Exports escape spreadsheet formulas; do not remove protection from untrusted fields.

## Synthetic demo

`npm run db:seed:demo` is optional and refuses databases without an `_demo`/`_test` suffix or with existing branches/users. Provision and migrate a separate empty demo database, then create ignored `.local/demo.env` with `MIGRATION_DATABASE_URL`, your supplied `ADMIN_USERNAME`, `ADMIN_DISPLAY_NAME`, `ADMIN_PASSWORD`, and `DEMO_SEED_CONFIRM=synthetic-empty-database`. It creates two synthetic branches, a unit, a notebook variant and two prices, with audit/history. It never imports the local business intake. Demo setup is a one-time empty-database workflow; if interrupted, recreate that disposable demo database before retrying.
