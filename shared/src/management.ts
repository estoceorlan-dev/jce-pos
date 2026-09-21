import { z } from 'zod';
export const managedPermissions = [
  'catalog.read',
  'catalog.manage',
  'prices.manage',
  'partners.read',
  'partners.manage',
  'contacts.read',
  'users.manage',
  'branches.manage',
  'settings.manage',
  'settings.global',
  'history.read',
] as const;
export type ManagedPermission = (typeof managedPermissions)[number];
export const uuid = z.uuid();
export const version = z.number().int().positive();
export const code = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/);
export const label = z.string().trim().min(1).max(160);
export const password = z.string().min(12).max(128);
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
export const userInput = z
  .object({
    username,
    displayName: label.max(120),
    password: password.optional(),
    roles: z
      .array(z.enum(['admin', 'manager', 'cashier', 'inventory']))
      .min(1)
      .max(4),
    branchIds: z.array(uuid).max(100),
    disabled: z.boolean().default(false),
    version: version.optional(),
  })
  .strict();
export const branchInput = z
  .object({
    code,
    name: label,
    archived: z.boolean().default(false),
    version: version.optional(),
  })
  .strict();
export const businessInput = z
  .object({
    name: label,
    address: z.string().max(500),
    currency: z.literal('PHP'),
    timezone: z.literal('Asia/Manila'),
    receiptFooter: z.string().max(500),
    receiptSeries: code,
    taxConfirmed: z.boolean(),
    version,
  })
  .strict();
export const branchSettingsInput = z
  .object({
    tenders: z
      .array(z.enum(['cash', 'card', 'ewallet']))
      .min(1)
      .max(3),
    discountThreshold: z.string().regex(/^\d{1,6}(\.\d{1,2})?$/),
    printerName: z.string().max(160),
    paperWidth: z.enum(['58', '80']),
    version,
  })
  .strict();
export const lookupInput = z
  .object({
    name: label,
    fractional: z.boolean().default(false),
    archived: z.boolean().default(false),
    version: version.optional(),
  })
  .strict();
export const taxInput = z
  .object({
    code,
    name: label,
    rate: z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/),
    inclusive: z.boolean(),
    archived: z.boolean().default(false),
    version: version.optional(),
  })
  .strict();
export const quantity = z.string().regex(/^\d{1,18}(\.\d{1,6})?$/);
export const money = z.string().regex(/^\d{1,18}(\.\d{1,2})?$/);
export const variantInput = z
  .object({
    productId: uuid.optional(),
    productName: label,
    categoryId: uuid.nullable(),
    brandId: uuid.nullable(),
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),
    name: label,
    unitId: uuid,
    conversion: quantity.refine((v) => Number(v) > 0),
    fractional: z.boolean(),
    minimumStock: quantity,
    taxCodeId: uuid.nullable(),
    barcodes: z
      .array(z.string().trim().min(1).max(64))
      .max(20)
      .refine((v) => new Set(v).size === v.length),
    archived: z.boolean().default(false),
    version: version.optional(),
  })
  .strict();
export const partnerInput = z
  .object({
    name: label,
    contact: z.string().trim().max(500),
    archived: z.boolean().default(false),
    version: version.optional(),
  })
  .strict();
export const searchInput = z
  .object({
    q: z.string().max(100).default(''),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    archived: z.enum(['true', 'false', 'all']).default('false'),
  })
  .strict();
export type SessionView = {
  user: { id: string; username: string; displayName: string };
  roles: string[];
  permissions: string[];
  branches: { id: string; name: string; code: string }[];
  branchId: string | null;
  csrfToken: string;
  locked: boolean;
  mustChangePassword: boolean;
};
