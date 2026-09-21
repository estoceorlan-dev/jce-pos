# ADR 0005: Local identity and master data

Status: implemented for L3/L4. Owner acceptance and production qualification remain separate gates.

## Authentication and authorization

Administrator bootstrap is a one-time operator command using a supplied secret and the migration credential. There is no default password or public bootstrap route. Passwords use Argon2id (64 MiB, three iterations, one lane). Password reset is administrator-only, forces a change and revokes all existing sessions. Password/account/membership changes revoke affected sessions transactionally. Permissions are fetched from PostgreSQL for every request, so a role permission change takes effect immediately.

Sessions use random 256-bit opaque tokens with only SHA-256 digests in PostgreSQL. The HTTPS cookie is `__Host-jce_session`, HttpOnly, Secure, SameSite=Strict, path `/`, without a Domain attribute. Idle expiry is 30 minutes; absolute expiry is eight hours. Session polling does not renew idle expiry. Locked sessions can inspect session state, unlock or sign out; ordinary work is denied. CSRF tokens are derived from the random session token using a separate prefix. Every write requires the configured Origin; authenticated writes also require the session CSRF header.

The API runs behind an HTTPS proxy on the same host and trusts only loopback proxy addresses. HTTP authentication is allowed only with explicit development/test loopback configuration. Production refuses this exception. The Express startup checks the unprivileged runtime database role. Runtime failures are opaque; request logs omit URLs, headers, bodies, credentials and contacts. Persistent 15-minute attempt windows allow ten attempts per username and 100 per IP; password/unlock operations also have per-user limits. Unknown usernames undergo the same password verification work. This conservative throttle can temporarily lock out a targeted username; investigate persistent failed attempts through login history.

All authenticated operations and authorization mutations serialize on a PostgreSQL advisory transaction lock. Each operation reloads session, permissions and branch membership under that lock. This favors correctness for this stage; capacity testing and narrower locking must precede production if contention is material. A deferred database constraint prevents removal/disable of the last active administrator. Managers cannot manage administrators, users with branches outside their scope, or roles whose permissions exceed their own. Granular role editing is administrator-only; administrator permissions cannot be edited through the API.

## Data scope and lifecycle

Products, variants, categories, brands, units and tax definitions are installation-wide. `catalog.manage` is deliberately a global permission. Prices, contacts, register settings and imports use explicit branch routes and live membership checks. A UUID from another branch does not bypass scope checks. Contact reads, writes and export columns additionally require `contacts.read`; updates by staff without it preserve hidden existing contacts.

Codes and identifiers preserve history. Branches, users, catalog definitions and contacts are archived/disabled rather than deleted. Terminal identity remains immutable; registers can be archived. Updates require optimistic versions; editing shared product details also requires the product version. Each sellable variant has an explicit base unit and exact conversion factor. A fractional variant requires a fractional unit. Low-stock thresholds are expressed in selling units, with conversion applied by the future inventory module. There are no balances or stock writes in L4.

Prices are branch-specific decimal strings backed by PostgreSQL numeric values; absent prices remain unset. Price, tax and setting history is immutable. Future posted sales/refunds must store their own snapshots and atomically append customer transaction links; the L4 customer-history endpoint is read-only and starts empty. Walk-in selection requires no customer record.

Every management mutation records reference-only audit and outbox entries in its transaction. `master.changed` is a versioned change notification containing an entity UUID and a reviewed kind, without passwords, contacts or arbitrary request snapshots. It is not a transport or a full replayable master-data replication format. The later synchronization phase must introduce reviewed payload/snapshot contracts before consuming it remotely. Delivery remains disabled.

## CSV imports

The template has a fixed header and explicit decimal/boolean columns. A staged file has at most 500 data rows and 50,000 characters, within the overall 64 KiB JSON body limit. The parser bounds individual records. Staging checks units, quantities, repeated/existing SKUs and barcode collisions and records preview rows and row errors. Duplicate policy is explicit: reject or skip; neither overwrites an existing item. A stage belongs to its initiating user and branch and expires after one day.

Commit locks the stage, revalidates accepted rows, then creates products, aliases, prices, histories, audit and outbox in one transaction. The persisted stage UUID is the idempotency key. A successful replay returns its original result; a conflict or failed step leaves no partial products/prices. Preview skip decisions never silently expand after concurrent changes. CSV exports quote fields and prefix spreadsheet formula-like cells, including prefixes hidden behind whitespace/control characters. Partner exports are bounded to the current filtered page.

## Sources

Security choices follow the [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [Express security guidance](https://expressjs.com/en/advanced/best-practice-security/) and the [node-argon2 implementation](https://github.com/ranisalt/node-argon2). CSV parsing uses documented [CSV Parse options](https://csv.js.org/parse/options/). These sources inform technical implementation, not tax or owner policy approval.
