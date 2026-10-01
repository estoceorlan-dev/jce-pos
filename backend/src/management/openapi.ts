import { z } from 'zod';
import {
  userInput,
  branchInput,
  businessInput,
  branchSettingsInput,
  lookupInput,
  taxInput,
  variantInput,
  partnerInput,
  username,
  password,
  money,
  uuid,
  code,
  version,
  managedPermissions,
  stockDocumentInput,
  stockPostInput,
  reservationInput,
  purchaseOrderInput,
  purchaseReceiptInput,
  purchaseReversalInput,
  purchasingApproval,
  purchasingTransition,
  purchasePost,
  cartInput,
  cartAction,
  discountApproval,
  checkoutInput,
  registerOpenInput,
  printInput,
  correctionInput,
} from '@jce/shared';
export const managementPaths: Record<string, Record<string, unknown>> = {};
function add(
  method: string,
  path: string,
  permission: string,
  input?: z.ZodType,
) {
  const parameters: object[] = [...path.matchAll(/\{([^}]+)\}/g)].map(
    (match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }),
  );
  if (method !== 'get') {
    parameters.push({
      name: 'Origin',
      in: 'header',
      required: true,
      schema: { type: 'string' },
      description: 'Must equal configured APP_ORIGIN.',
    });
    if (path !== '/auth/login')
      parameters.push({
        name: 'X-CSRF-Token',
        in: 'header',
        required: true,
        schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      });
  }
  const operation = {
    summary: `${method.toUpperCase()} ${path}`,
    description: permission,
    security: path === '/auth/login' ? [] : [{ session: [] }],
    parameters,
    ...(input
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: z.toJSONSchema(input, {
                  io: 'input',
                  unrepresentable: 'any',
                }),
              },
            },
          },
        }
      : {}),
    responses: {
      '200': {
        description: 'Success. Decimal amounts are strings; lists are bounded.',
      },
      '400': { description: 'Invalid input' },
      '401': { description: 'Missing, expired or revoked session' },
      '403': { description: 'Permission, branch, origin or CSRF check failed' },
      '404': { description: 'Record not found in the authorized scope' },
      '409': {
        description:
          'Duplicate, stale version, protected record or changed import',
      },
      '423': { description: 'Workstation locked' },
      '429': { description: 'Login/password attempt limit' },
    },
  };
  const target = '/api/v1' + path;
  (managementPaths[target] ??= {})[method] = operation;
}
const stockBase = '/branches/{branchId}/inventory';
const reconciliationBase = '/branches/{branchId}/reconciliation';
for (const path of [
  '/sessions',
  '/sessions/{id}',
  '/requests',
  '/requests/{id}',
  '/sales/{id}',
])
  add(
    'get',
    reconciliationBase + path,
    'Branch membership plus cashier ownership or relevant review permission; original-sale lookup requires returns.use.',
  );
add(
  'post',
  reconciliationBase + '/preview-return',
  'returns.use + branch membership; server refund allocation preview.',
  correctionInput,
);
add(
  'post',
  reconciliationBase + '/requests',
  'returns.use, checkout.use or register.close according to kind; original cashier/open session.',
  z.object({ requestKey: uuid, input: correctionInput }).strict(),
);
for (const kind of ['return', 'cash'])
  add(
    'post',
    reconciliationBase + '/requests/{id}/approve-' + kind,
    kind === 'return'
      ? 'returns.approve; different reviewer, exact request, five-minute expiry.'
      : 'cash.approve; different reviewer, exact request, five-minute expiry.',
    z
      .object({ requestKey: uuid, password: z.string().min(1).max(128) })
      .strict(),
  );
add(
  'post',
  reconciliationBase + '/requests/{id}/post',
  'Original requesting cashier and current operation permission; immutable request identity prevents duplicate posting.',
  z.object({ requestKey: uuid }).strict(),
);
const checkoutBase = '/branches/{branchId}/checkout';
add(
  'get',
  checkoutBase + '/options',
  'checkout.use + branch membership. Bounded q/customerQ search, register sessions and setup status.',
);
add(
  'post',
  checkoutBase + '/sessions',
  'checkout.use + branch membership. Unique open terminal session; idempotent opening float.',
  registerOpenInput,
);
add(
  'get',
  checkoutBase + '/carts',
  'checkout.use + branch membership. Own active/held carts; reviewers can see branch carts. Bounded page/limit.',
);
add(
  'get',
  checkoutBase + '/carts/{id}',
  'checkout.use + branch membership + author or checkout.approve.',
);
add(
  'post',
  checkoutBase + '/carts',
  'checkout.use + branch membership.',
  z.object({ requestKey: uuid, cart: cartInput }).strict(),
);
add(
  'put',
  checkoutBase + '/carts/{id}',
  'checkout.use + branch membership + author. Reprices and invalidates approval.',
  z.object({ version, cart: cartInput }).strict(),
);
for (const action of ['hold', 'resume', 'cancel'])
  add(
    'post',
    checkoutBase + '/carts/{id}/' + action,
    'checkout.use + branch membership + author.',
    cartAction,
  );
add(
  'post',
  checkoutBase + '/carts/{id}/approve-discount',
  'checkout.approve + branch membership. Different password-confirmed reviewer, exact cart version and quote, five-minute expiry.',
  discountApproval,
);
add(
  'post',
  checkoutBase + '/carts/{id}/post',
  'checkout.use + branch membership + author/open session. Atomic sale and stock; retain exact request key and payments on transport failure.',
  checkoutInput,
);
add(
  'get',
  checkoutBase + '/requests/{key}',
  'checkout.use + branch membership + original cashier. Returns sale or null; null does not authorize replacing an in-flight request key.',
);
add(
  'get',
  '/branches/{branchId}/sales',
  'sales.read + branch membership. Bounded page/limit/q and unprinted=true filter.',
);
add(
  'get',
  '/branches/{branchId}/sales/{id}',
  'sales.read + branch membership. Committed receipt snapshots and print history.',
);
add(
  'post',
  '/branches/{branchId}/sales/{id}/print',
  'sales.read + branch membership. Requested print or same-operator confirmation/failure of a prior attempt; append-only and idempotent.',
  printInput,
);
const purchasingBase = '/branches/{branchId}/purchasing';
for (const suffix of [
  '/options',
  '/orders',
  '/orders/{id}',
  '/receipts',
  '/receipts/{id}',
])
  add(
    'get',
    purchasingBase + suffix,
    'purchasing.read + branch membership. Decimal strings, bounded lists; receipt history supports supplierId/orderId and includes posted signed totals.',
  );
for (const [kind, input, permission] of [
  ['orders', purchaseOrderInput, 'purchasing.manage'],
  ['receipts', purchaseReceiptInput, 'purchasing.receive'],
] as const) {
  const key = kind === 'orders' ? 'order' : 'receipt';
  add(
    'post',
    `${purchasingBase}/${kind}`,
    permission + ' + branch membership. Creates a draft only.',
    z.object({ requestKey: uuid, [key]: input }).strict(),
  );
  add(
    'put',
    `${purchasingBase}/${kind}/{id}`,
    permission +
      ' + branch membership + draft author. Requires current version.',
    z.object({ version, [key]: input }).strict(),
  );
}
for (const action of ['submit', 'cancel', 'approve', 'reject', 'close'])
  add(
    'post',
    `${purchasingBase}/orders/{id}/${action}`,
    ['submit', 'cancel'].includes(action)
      ? 'purchasing.manage + original author. Versioned state transition.'
      : 'purchasing.approve + different author + fresh password. Exact version and reason.',
    ['submit', 'cancel'].includes(action)
      ? purchasingTransition
      : purchasingApproval,
  );
for (const action of ['post', 'cancel'])
  add(
    'post',
    `${purchasingBase}/receipts/{id}/${action}`,
    'purchasing.receive + original author + branch membership. Idempotent; rejects excess receiving and duplicate delivery references.',
    purchasePost,
  );
add(
  'post',
  purchasingBase + '/reversals',
  'purchasing.receive + branch membership. Creates a full reversal draft linked to an immutable posted receipt.',
  purchaseReversalInput,
);
add(
  'post',
  purchasingBase + '/receipts/{id}/approve-reversal',
  'purchasing.approve + different author + fresh password. Rejects subsequent stock movements or insufficient available quantity/value. Exact original quantity/value reversal.',
  purchasePost.extend({ password: z.string().min(1).max(128) }),
);
for (const suffix of [
  '',
  '/documents',
  '/documents/{id}',
  '/documents/{id}/report',
  '/movements/{variantId}',
  '/reservations',
  '/reconciliation',
])
  add(
    'get',
    stockBase + suffix,
    'inventory.read + branch membership. Quantities and valuation use decimal strings in base units. Report returns CSV; reconciliation returns a single consistent snapshot.',
  );
add(
  'post',
  stockBase + '/documents',
  'inventory.manage + branch membership. Creates a versioned draft; count drafts freeze the complete variant scope.',
  z.object({ requestKey: uuid, document: stockDocumentInput }).strict(),
);
add(
  'put',
  stockBase + '/documents/{id}',
  'inventory.manage + original author + branch membership. Edits invalidate the reviewed version and refresh balance snapshots.',
  z.object({ version, document: stockDocumentInput }).strict(),
);
add(
  'post',
  stockBase + '/documents/{id}/post',
  'inventory.approve + branch membership + different author. Fresh own-password confirmation; review and posting are atomic. Idempotent request key excludes the password from persistence.',
  stockPostInput,
);
add(
  'post',
  stockBase + '/documents/{id}/cancel',
  'inventory.manage + branch membership. Cancels only the current draft and releases its count freeze.',
  z.object({ version, requestKey: uuid }).strict(),
);
add(
  'post',
  stockBase + '/reservations',
  'inventory.reserve + branch membership. Locks sellable stock and rejects insufficient availability.',
  reservationInput,
);
add(
  'post',
  stockBase + '/reservations/{id}/release',
  'inventory.reserve + branch membership. Releases stock exactly once.',
  z.object({ requestKey: uuid }).strict(),
);
add(
  'post',
  stockBase + '/import',
  'inventory.manage + branch membership. Validates all CSV rows and creates an opening draft with a manifest and reconciliation preview. Header: sku,condition,quantity,unitCost. Maximum 100 rows. No stock effects until reviewed posting.',
  z
    .object({
      requestKey: uuid,
      csv: z.string().max(50000),
      sourceReference: z.string().min(1).max(160),
      openingDate: z.iso.date(),
      note: z.string().min(1).max(500),
    })
    .strict(),
);
add(
  'post',
  '/auth/login',
  'Public over configured origin; rate limited.',
  z.object({ username, password: z.string().min(1).max(128) }).strict(),
);
add(
  'get',
  '/auth/session',
  'Authenticated, including locked or password-change-required sessions.',
);
for (const action of ['logout', 'lock'])
  add('post', `/auth/${action}`, 'Authenticated, including locked sessions.');
add(
  'post',
  '/auth/unlock',
  'Authenticated; rate limited.',
  z.object({ password: z.string().min(1).max(128) }).strict(),
);
add(
  'post',
  '/auth/password',
  'Unlocked authenticated user. Revokes all sessions.',
  z.object({ currentPassword: z.string().min(1).max(128), password }).strict(),
);
add(
  'post',
  '/auth/branch',
  'Live branch membership required.',
  z.object({ branchId: uuid }).strict(),
);
add('get', '/roles', 'users.manage');
add(
  'put',
  '/roles/{role}',
  'Administrator only; admin role is immutable.',
  z
    .object({ permissions: z.array(z.enum(managedPermissions)), version })
    .strict(),
);
add(
  'get',
  '/users',
  'users.manage; managers see only users wholly within their branch scope.',
);
add(
  'post',
  '/users',
  'users.manage; no grant may exceed caller authority.',
  userInput,
);
add(
  'put',
  '/users/{id}',
  'users.manage; version required; no password field on updates.',
  userInput,
);
add(
  'post',
  '/users/{id}/reset',
  'Administrator only.',
  z.object({ password, version }).strict(),
);
add(
  'get',
  '/login-history',
  'history.read; non-admins see only their own history.',
);
add(
  'get',
  '/branches',
  'Authenticated; branch administrators see archived records.',
);
add('post', '/branches', 'branches.manage', branchInput);
add(
  'put',
  '/branches/{branchId}',
  'branches.manage + membership (including archived branches).',
  branchInput,
);
for (const [path, permission, input] of [
  ['/settings/business', 'settings.global', businessInput],
  ['/branches/{branchId}/settings', 'settings.manage', branchSettingsInput],
] as const) {
  add('get', path, permission);
  add('put', path, permission, input);
  add('get', path + '/history', permission);
}
add(
  'get',
  '/branches/{branchId}/registers',
  'settings.manage + branch membership.',
);
add(
  'post',
  '/branches/{branchId}/terminals',
  'settings.manage + branch membership.',
  z.object({ code }).strict(),
);
for (const [method, path] of [
  ['post', '/branches/{branchId}/registers'],
  ['put', '/branches/{branchId}/registers/{id}'],
])
  add(
    method!,
    path!,
    'settings.manage; terminal must belong to this branch.',
    z
      .object({
        code,
        terminalId: uuid,
        archived: z.boolean().default(false),
        version: version.optional(),
      })
      .strict(),
  );
add('get', '/catalog/lookups', 'catalog.read; shared catalog definitions.');
for (const type of ['categories', 'brands', 'units', 'taxes']) {
  const input = type === 'taxes' ? taxInput : lookupInput;
  const permission = type === 'taxes' ? 'settings.global' : 'catalog.manage';
  add('post', `/catalog/${type}`, permission, input);
  add('put', `/catalog/${type}/{id}`, permission, input);
}
add('get', '/catalog/taxes/{id}/history', 'settings.global');
add(
  'get',
  '/branches/{branchId}/catalog',
  'catalog.read + branch membership. Query: q (max 100), page (1–10000), limit (1–100), archived (false/true/all). Returns {items,hasMore}.',
);
add(
  'get',
  '/branches/{branchId}/catalog/{id}',
  'catalog.read + branch membership.',
);
for (const [method, path] of [
  ['post', '/catalog/variants'],
  ['put', '/catalog/variants/{id}'],
])
  add(
    method!,
    path!,
    'catalog.manage; shared across branches; version and productVersion required when editing.',
    variantInput.extend({ productVersion: version.optional() }),
  );
add(
  'put',
  '/branches/{branchId}/prices/{id}',
  'prices.manage + branch membership. Version 0 creates the first price.',
  z.object({ amount: money, version: z.number().int().min(0) }).strict(),
);
add(
  'get',
  '/branches/{branchId}/prices/{id}/history',
  'catalog.read + branch membership.',
);
for (const type of ['customers', 'suppliers']) {
  const path = `/branches/{branchId}/${type}`;
  add(
    'get',
    path,
    'partners.read + branch membership. Same bounded search query as catalog. Contact fields require contacts.read.',
  );
  add(
    'get',
    path + '/export',
    'partners.read + branch membership. CSV of current filtered page; contacts.read controls contact columns.',
  );
  add('get', path + '/{id}', 'partners.read + branch membership.');
  add('post', path, 'partners.manage + branch membership.', partnerInput);
  add(
    'put',
    path + '/{id}',
    'partners.manage + branch membership. Version required. Contacts require contacts.read.',
    partnerInput,
  );
}
add(
  'get',
  '/branches/{branchId}/customers/{id}/history',
  'partners.read + branch membership. Posted source links are populated by L7/L8.',
);
add(
  'get',
  '/catalog/import-template',
  'catalog.manage. Returns template as text/csv.',
);
add(
  'post',
  '/branches/{branchId}/imports',
  'catalog.manage + prices.manage + branch membership. Stages up to 500 rows; no catalog write.',
  z
    .object({
      csv: z.string().max(50000),
      duplicatePolicy: z.enum(['reject', 'skip']),
    })
    .strict(),
);
for (const suffix of ['', '/errors'])
  add(
    'get',
    `/branches/{branchId}/imports/{id}${suffix}`,
    'catalog.manage + branch membership + original staging user. Errors returns text/csv.',
  );
add(
  'post',
  '/branches/{branchId}/imports/{id}/commit',
  'catalog.manage + prices.manage + branch membership + original staging user. Stage ID is the persisted idempotency key; replay returns original result. Revalidates rows and commits atomically.',
);
