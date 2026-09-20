import { z } from 'zod';

export const APP_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;
export const permissionSchema = z.enum([
  'catalog.read',
  'inventory.read',
  'sales.read',
  'checkout.use',
  'reports.read',
  'settings.manage',
]);
export type Permission = z.infer<typeof permissionSchema>;
export const paginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ApiError = {
  error: { code: string; message: string; requestId: string };
};
export const readinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
});
export const versionSchema = z.object({
  version: z.string(),
  apiVersion: z.literal('v1'),
  schemaVersion: z.number().int(),
});
export const navigation = [
  { path: '/catalog', label: 'Catalog', permission: 'catalog.read' },
  { path: '/inventory', label: 'Inventory', permission: 'inventory.read' },
  { path: '/sales', label: 'Sales', permission: 'sales.read' },
  { path: '/checkout', label: 'Checkout', permission: 'checkout.use' },
  { path: '/reports', label: 'Reports', permission: 'reports.read' },
  { path: '/settings', label: 'Settings', permission: 'settings.manage' },
] as const satisfies ReadonlyArray<{
  path: string;
  label: string;
  permission: Permission;
}>;
export function canAccess(
  grants: readonly Permission[],
  permission: Permission,
): boolean {
  return grants.includes(permission);
}
