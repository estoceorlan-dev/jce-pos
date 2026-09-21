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
