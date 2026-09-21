import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import {
  uuid,
  version,
  lookupInput,
  taxInput,
  variantInput,
  partnerInput,
  searchInput,
  money,
} from '@jce/shared';
import type { Endpoint, Context } from './router.js';
import {
  HttpError,
  recordChange,
  requireFound,
  requireUpdated,
} from './common.js';

export function csvCell(value: unknown) {
  const text = String(value ?? '');
  // Control characters can conceal a spreadsheet formula prefix.
  // eslint-disable-next-line no-control-regex
  const unsafe = /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(text);
  return `"${(unsafe ? "'" + text : text).replaceAll('"', '""')}"`;
}
export function csv(rows: unknown[][]) {
  return (
    '\uFEFF' +
    rows.map((row) => row.map(csvCell).join(',')).join('\r\n') +
    '\r\n'
  );
}
const tables = {
  categories: 'product_categories',
  brands: 'product_brands',
  units: 'product_units',
} as const;
const kinds = {
  categories: 'category',
  brands: 'brand',
  units: 'unit',
} as const;
const listQuery = `SELECT v.id,v.product_id,v.sku,v.name,v.unit_id,v.conversion,v.fractional,v.minimum_stock,v.tax_code_id,v.archived,v.version,p.name AS product_name,p.category_id,p.brand_id,p.version AS product_version,u.name AS unit_name,pr.amount AS price,pr.version AS price_version,ARRAY(SELECT barcode FROM product_barcodes WHERE variant_id=v.id ORDER BY barcode) AS barcodes FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id LEFT JOIN product_prices pr ON pr.variant_id=v.id AND pr.branch_id=$1`;
const variantSchema = variantInput.extend({
  productVersion: version.optional(),
});
export async function saveVariant(
  ctx: Pick<Context, 'tx' | 'session'>,
  input: unknown,
  existing?: string,
) {
  const { tx, session } = ctx;
  const data = variantSchema.parse(input);
  const id = existing ?? randomUUID();
  for (const [table, key] of [
    ['product_units', data.unitId],
    ['product_categories', data.categoryId],
    ['product_brands', data.brandId],
    ['tax_codes', data.taxCodeId],
  ] as const) {
    if (
      key &&
      !(
        await tx.query(
          `SELECT id FROM ${table} WHERE id=$1 AND (NOT archived OR $2)`,
          [key, data.archived],
        )
      ).rowCount
    )
      throw new HttpError(
        400,
        'INVALID_REFERENCE',
        'Choose active catalog references.',
      );
  }
  const unit = (
    await tx.query<{ fractional: boolean }>(
      'SELECT fractional FROM product_units WHERE id=$1',
      [data.unitId],
    )
  ).rows[0]!;
  if (
    (data.fractional && !unit.fractional) ||
    (!data.fractional && !/^\d+(\.0+)?$/.test(data.minimumStock))
  )
    throw new HttpError(
      400,
      'INVALID_QUANTITY',
      'Fractional quantities must be permitted by the unit and variant.',
    );
  // Scanner input has one namespace across SKUs and barcode aliases.
  const codes = [data.sku, ...data.barcodes];
  const collision = await tx.query(
    'SELECT 1 FROM product_variants WHERE sku=ANY($1::text[]) AND id<>$2 UNION ALL SELECT 1 FROM product_barcodes WHERE barcode=ANY($1::text[]) AND variant_id<>$2',
    [codes, id],
  );
  if (collision.rowCount)
    throw new HttpError(
      409,
      'DUPLICATE_CODE',
      'A SKU or barcode is already assigned.',
    );
  const productId = data.productId ?? randomUUID();
  if (existing) {
    const old = requireFound(
      (
        await tx.query<{ product_id: string }>(
          'SELECT product_id FROM product_variants WHERE id=$1',
          [id],
        )
      ).rows[0],
    );
    if (old.product_id !== productId)
      throw new HttpError(
        400,
        'INVALID_PRODUCT',
        'A variant cannot move to another product.',
      );
  }
  if (data.productId) {
    requireUpdated(
      (
        await tx.query(
          'UPDATE products SET name=$2,category_id=$3,brand_id=$4,version=version+1 WHERE id=$1 AND version=$5',
          [
            productId,
            data.productName,
            data.categoryId,
            data.brandId,
            data.productVersion,
          ],
        )
      ).rowCount,
    );
  } else
    await tx.query(
      'INSERT INTO products(id,name,category_id,brand_id) VALUES($1,$2,$3,$4)',
      [productId, data.productName, data.categoryId, data.brandId],
    );
  const values = [
    id,
    productId,
    data.sku,
    data.name,
    data.unitId,
    data.conversion,
    data.fractional,
    data.minimumStock,
    data.taxCodeId,
    data.archived,
  ];
  if (existing)
    requireUpdated(
      (
        await tx.query(
          'UPDATE product_variants SET sku=$3,name=$4,unit_id=$5,conversion=$6,fractional=$7,minimum_stock=$8,tax_code_id=$9,archived=$10,version=version+1 WHERE id=$1 AND product_id=$2 AND version=$11',
          [...values, data.version],
        )
      ).rowCount,
    );
  else
    await tx.query(
      'INSERT INTO product_variants(id,product_id,sku,name,unit_id,conversion,fractional,minimum_stock,tax_code_id,archived) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      values,
    );
  await tx.query('DELETE FROM product_barcodes WHERE variant_id=$1', [id]);
  for (const barcode of data.barcodes)
    await tx.query('INSERT INTO product_barcodes VALUES($1,$2)', [barcode, id]);
  await recordChange(
    tx,
    session.user.id,
    null,
    'variant',
    id,
    existing ? data.version! + 1 : 1,
  );
  return { id, productId };
}
export async function savePrice(
  ctx: Pick<Context, 'tx' | 'session' | 'branchId'>,
  id: string,
  amount: string,
  expected: number,
) {
  const { tx, session, branchId } = ctx;
  requireFound(
    (
      await tx.query(
        'SELECT id FROM product_variants WHERE id=$1 AND NOT archived',
        [id],
      )
    ).rows[0],
  );
  const updated =
    expected === 0
      ? await tx.query<{ id: string }>(
          'INSERT INTO product_prices(branch_id,variant_id,amount) VALUES($1,$2,$3) RETURNING id',
          [branchId, id, amount],
        )
      : await tx.query<{ id: string }>(
          'UPDATE product_prices SET amount=$3,version=version+1 WHERE branch_id=$1 AND variant_id=$2 AND version=$4 RETURNING id',
          [branchId, id, amount, expected],
        );
  requireUpdated(updated.rowCount);
  const historyId = randomUUID();
  await tx.query(
    'INSERT INTO product_price_history(id,branch_id,variant_id,amount,version,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
    [historyId, branchId, id, amount, expected + 1, session.user.id],
  );
  await recordChange(
    tx,
    session.user.id,
    branchId,
    'price',
    updated.rows[0]!.id,
    expected + 1,
  );
}
const columns = [
  'sku',
  'product_name',
  'variant_name',
  'unit',
  'conversion',
  'fractional',
  'minimum_stock',
  'barcode',
  'price',
] as const;
const importRow = z.object({
  sku: variantInput.shape.sku,
  product_name: variantInput.shape.productName,
  variant_name: variantInput.shape.name,
  unit: z.string().trim().min(1).max(160),
  conversion: variantInput.shape.conversion,
  fractional: z.enum(['true', 'false']),
  minimum_stock: variantInput.shape.minimumStock,
  barcode: z.string().trim().max(64),
  price: money,
});
type ImportRow = z.infer<typeof importRow> & { line: number; skip: boolean };
type ImportError = { line: number; message: string };
export function parseCatalogCsv(text: string) {
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 4096,
      relax_column_count: false,
    }) as string[][];
  } catch {
    throw new HttpError(
      400,
      'INVALID_CSV',
      'CSV is malformed or a row exceeds 4 KB.',
    );
  }
  if (!records[0] || records[0].join(',') !== columns.join(','))
    throw new HttpError(
      400,
      'INVALID_COLUMNS',
      `Use the template columns: ${columns.join(', ')}.`,
    );
  if (records.length < 2 || records.length > 501)
    throw new HttpError(
      400,
      'IMPORT_SIZE',
      'Import between 1 and 500 data rows.',
    );
  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];
  records.slice(1).forEach((values, index) => {
    const result = importRow.safeParse(
      Object.fromEntries(columns.map((key, i) => [key, values[i]])),
    );
    if (result.success)
      rows.push({ ...result.data, line: index + 2, skip: false });
    else
      errors.push({
        line: index + 2,
        message: `Invalid ${[...new Set(result.error.issues.map((i) => i.path.join('.')))].join(', ')}.`,
      });
  });
  return { rows, errors };
}
async function validateImport(
  ctx: Context,
  rows: ImportRow[],
  policy: 'reject' | 'skip',
) {
  const errors: ImportError[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const unit = (
      await ctx.tx.query<{ fractional: boolean }>(
        'SELECT fractional FROM product_units WHERE name=$1 AND NOT archived',
        [row.unit],
      )
    ).rows[0];
    if (!unit)
      errors.push({
        line: row.line,
        message: 'Unit must match an active unit name.',
      });
    else if (
      (row.fractional === 'true' && !unit.fractional) ||
      (row.fractional === 'false' && !/^\d+(\.0+)?$/.test(row.minimum_stock))
    )
      errors.push({
        line: row.line,
        message: 'Fractional quantity is not permitted.',
      });
    const codes = [row.sku, ...(row.barcode ? [row.barcode] : [])];
    const duplicate =
      codes.some((code) => seen.has(code)) ||
      (
        await ctx.tx.query(
          'SELECT 1 FROM product_variants WHERE sku=ANY($1::text[]) UNION ALL SELECT 1 FROM product_barcodes WHERE barcode=ANY($1::text[])',
          [codes],
        )
      ).rowCount! > 0;
    row.skip = duplicate && policy === 'skip';
    if (duplicate && policy === 'reject')
      errors.push({
        line: row.line,
        message: 'SKU or barcode already exists in the catalog or this file.',
      });
    if (!row.skip) codes.forEach((code) => seen.add(code));
  }
  return errors;
}
export function installCatalog(endpoint: Endpoint) {
  endpoint('get', '/catalog/lookups', 'catalog.read', async ({ tx }) => {
    const output: Record<string, unknown> = {};
    for (const [name, table] of Object.entries(tables))
      output[name] = (
        await tx.query(`SELECT * FROM ${table} ORDER BY name LIMIT 1000`)
      ).rows;
    output['taxes'] = (
      await tx.query('SELECT * FROM tax_codes ORDER BY code LIMIT 1000')
    ).rows;
    return output;
  });
  for (const name of ['categories', 'brands', 'units'] as const) {
    const save = async ({ tx, session, req }: Context) => {
      const data = lookupInput.parse(req.body);
      const table = tables[name];
      const id = req.params['id'] ? uuid.parse(req.params['id']) : randomUUID();
      if (req.params['id']) {
        if (
          name === 'units' &&
          !data.fractional &&
          (
            await tx.query(
              'SELECT 1 FROM product_variants WHERE unit_id=$1 AND fractional',
              [id],
            )
          ).rowCount
        )
          throw new HttpError(
            409,
            'UNIT_IN_USE',
            'Fractional variants still use this unit.',
          );
        const params =
          name === 'units'
            ? [id, data.name, data.archived, data.version, data.fractional]
            : [id, data.name, data.archived, data.version];
        requireUpdated(
          (
            await tx.query(
              `UPDATE ${table} SET name=$2,archived=$3,version=version+1 ${name === 'units' ? ',fractional=$5' : ''} WHERE id=$1 AND version=$4`,
              params,
            )
          ).rowCount,
        );
      } else
        await tx.query(
          `INSERT INTO ${table}(id,name,archived${name === 'units' ? ',fractional' : ''}) VALUES($1,$2,$3${name === 'units' ? ',$4' : ''})`,
          name === 'units'
            ? [id, data.name, data.archived, data.fractional]
            : [id, data.name, data.archived],
        );
      await recordChange(
        tx,
        session.user.id,
        null,
        kinds[name],
        id,
        req.params['id'] ? data.version! + 1 : 1,
      );
      return { id };
    };
    endpoint('post', `/catalog/${name}`, 'catalog.manage', save);
    endpoint('put', `/catalog/${name}/:id`, 'catalog.manage', save);
  }
  const tax = async ({ tx, session, req }: Context) => {
    const data = taxInput.parse(req.body);
    const id = req.params['id'] ? uuid.parse(req.params['id']) : randomUUID();
    if (req.params['id'])
      requireUpdated(
        (
          await tx.query(
            'UPDATE tax_codes SET code=$2,name=$3,rate=$4,inclusive=$5,archived=$6,version=version+1 WHERE id=$1 AND version=$7',
            [
              id,
              data.code,
              data.name,
              data.rate,
              data.inclusive,
              data.archived,
              data.version,
            ],
          )
        ).rowCount,
      );
    else
      await tx.query(
        'INSERT INTO tax_codes(id,code,name,rate,inclusive,archived) VALUES($1,$2,$3,$4,$5,$6)',
        [id, data.code, data.name, data.rate, data.inclusive, data.archived],
      );
    const next = req.params['id'] ? data.version! + 1 : 1;
    await tx.query(
      'INSERT INTO tax_code_history(id,tax_id,version,value) VALUES($1,$2,$3,$4)',
      [randomUUID(), id, next, data],
    );
    await recordChange(tx, session.user.id, null, 'tax', id, next);
    return { id };
  };
  endpoint('post', '/catalog/taxes', 'settings.global', tax);
  endpoint('put', '/catalog/taxes/:id', 'settings.global', tax);
  endpoint(
    'get',
    '/catalog/taxes/:id/history',
    'settings.global',
    async ({ tx, req }) =>
      (
        await tx.query(
          'SELECT version,value,occurred_at FROM tax_code_history WHERE tax_id=$1 ORDER BY version DESC LIMIT 100',
          [uuid.parse(req.params['id'])],
        )
      ).rows,
  );
  endpoint(
    'get',
    '/branches/:branchId/catalog',
    'catalog.read',
    async ({ tx, req, branchId }) => {
      const data = searchInput.parse(req.query);
      const items = (
        await tx.query(
          `${listQuery} WHERE ($2='all' OR v.archived=($2='true')) AND ($3='' OR strpos(lower(p.name||' '||v.name||' '||v.sku),lower($3))>0 OR EXISTS(SELECT 1 FROM product_barcodes b WHERE b.variant_id=v.id AND b.barcode=$3)) ORDER BY v.sku LIMIT $4 OFFSET $5`,
          [
            branchId,
            data.archived,
            data.q,
            data.limit + 1,
            (data.page - 1) * data.limit,
          ],
        )
      ).rows;
      return {
        items: items.slice(0, data.limit),
        hasMore: items.length > data.limit,
      };
    },
  );
  endpoint(
    'get',
    '/branches/:branchId/catalog/:id',
    'catalog.read',
    async ({ tx, req, branchId }) =>
      requireFound(
        (
          await tx.query(`${listQuery} WHERE v.id=$2`, [
            branchId,
            uuid.parse(req.params['id']),
          ])
        ).rows[0],
      ),
  );
  endpoint('post', '/catalog/variants', 'catalog.manage', (ctx) =>
    saveVariant(ctx, ctx.req.body),
  );
  endpoint('put', '/catalog/variants/:id', 'catalog.manage', (ctx) =>
    saveVariant(ctx, ctx.req.body, uuid.parse(ctx.req.params['id'])),
  );
  endpoint(
    'put',
    '/branches/:branchId/prices/:id',
    'prices.manage',
    async (ctx) => {
      const data = z
        .object({ amount: money, version: z.number().int().min(0) })
        .strict()
        .parse(ctx.req.body);
      await savePrice(
        ctx,
        uuid.parse(ctx.req.params['id']),
        data.amount,
        data.version,
      );
    },
  );
  endpoint(
    'get',
    '/branches/:branchId/prices/:id/history',
    'catalog.read',
    async ({ tx, req, branchId }) =>
      (
        await tx.query(
          'SELECT id,amount,version,occurred_at FROM product_price_history WHERE branch_id=$1 AND variant_id=$2 ORDER BY version DESC LIMIT 100',
          [branchId, uuid.parse(req.params['id'])],
        )
      ).rows,
  );
  for (const table of ['suppliers', 'customers'] as const) {
    const select = (session: Context['session']) =>
      `id,name,archived,version${session.permissions.includes('contacts.read') ? ',contact' : ''}`;
    endpoint(
      'get',
      `/branches/:branchId/${table}`,
      'partners.read',
      async ({ tx, session, req, branchId }) => {
        const data = searchInput.parse(req.query);
        const rows = (
          await tx.query(
            `SELECT ${select(session)} FROM ${table} WHERE branch_id=$1 AND ($2='all' OR archived=($2='true')) AND strpos(lower(name),lower($3))>0 ORDER BY name,id LIMIT $4 OFFSET $5`,
            [
              branchId,
              data.archived,
              data.q,
              data.limit + 1,
              (data.page - 1) * data.limit,
            ],
          )
        ).rows;
        return {
          items: rows.slice(0, data.limit),
          hasMore: rows.length > data.limit,
        };
      },
    );
    endpoint(
      'get',
      `/branches/:branchId/${table}/export`,
      'partners.read',
      async ({ tx, session, branchId, req }) => {
        const data = searchInput.parse(req.query);
        const rows = (
          await tx.query(
            `SELECT ${select(session)} FROM ${table} WHERE branch_id=$1 AND ($2='all' OR archived=($2='true')) AND strpos(lower(name),lower($3))>0 ORDER BY name,id LIMIT $4 OFFSET $5`,
            [
              branchId,
              data.archived,
              data.q,
              data.limit,
              (data.page - 1) * data.limit,
            ],
          )
        ).rows;
        const headers = [
          'name',
          ...(session.permissions.includes('contacts.read') ? ['contact'] : []),
          'archived',
        ];
        return {
          csv: csv([headers, ...rows.map((r) => headers.map((h) => r[h]))]),
        };
      },
    );
    endpoint(
      'get',
      `/branches/:branchId/${table}/:id`,
      'partners.read',
      async ({ tx, session, req, branchId }) =>
        requireFound(
          (
            await tx.query(
              `SELECT ${select(session)} FROM ${table} WHERE id=$1 AND branch_id=$2`,
              [uuid.parse(req.params['id']), branchId],
            )
          ).rows[0],
        ),
    );
    const save = async ({ tx, session, req, branchId }: Context) => {
      const data = partnerInput.parse(req.body);
      const canContact = session.permissions.includes('contacts.read');
      if (data.contact && !canContact)
        throw new HttpError(
          403,
          'CONTACTS_FORBIDDEN',
          'Contact details require contact permission.',
        );
      const id = req.params['id'] ? uuid.parse(req.params['id']) : randomUUID();
      if (req.params['id'])
        requireUpdated(
          (
            await tx.query(
              `UPDATE ${table} SET name=$3,contact=CASE WHEN $6 THEN $4 ELSE contact END,archived=$5,version=version+1 WHERE id=$1 AND branch_id=$2 AND version=$7`,
              [
                id,
                branchId,
                data.name,
                data.contact,
                data.archived,
                canContact,
                data.version,
              ],
            )
          ).rowCount,
        );
      else
        await tx.query(
          `INSERT INTO ${table}(id,branch_id,name,contact,archived) VALUES($1,$2,$3,$4,$5)`,
          [id, branchId, data.name, data.contact, data.archived],
        );
      await recordChange(
        tx,
        session.user.id,
        branchId,
        table === 'suppliers' ? 'supplier' : 'customer',
        id,
        req.params['id'] ? data.version! + 1 : 1,
      );
      return { id };
    };
    endpoint('post', `/branches/:branchId/${table}`, 'partners.manage', save);
    endpoint(
      'put',
      `/branches/:branchId/${table}/:id`,
      'partners.manage',
      save,
    );
  }
  endpoint(
    'get',
    '/branches/:branchId/customers/:id/history',
    'partners.read',
    async ({ tx, req, branchId }) => {
      const id = uuid.parse(req.params['id']);
      requireFound(
        (
          await tx.query(
            'SELECT id FROM customers WHERE id=$1 AND branch_id=$2',
            [id, branchId],
          )
        ).rows[0],
      );
      return (
        await tx.query(
          'SELECT source_type,source_id,amount,occurred_at FROM customer_transactions WHERE branch_id=$1 AND customer_id=$2 ORDER BY occurred_at DESC LIMIT 100',
          [branchId, id],
        )
      ).rows;
    },
  );
  endpoint('get', '/catalog/import-template', 'catalog.manage', async () => ({
    csv: csv([columns as unknown as string[]]),
  }));
  endpoint(
    'post',
    '/branches/:branchId/imports',
    'catalog.manage',
    async (ctx) => {
      if (!ctx.session.permissions.includes('prices.manage'))
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Importing branch prices requires price permission.',
        );
      const data = z
        .object({
          csv: z.string().max(50000),
          duplicatePolicy: z.enum(['reject', 'skip']),
        })
        .strict()
        .parse(ctx.req.body);
      const { rows, errors } = parseCatalogCsv(data.csv);
      errors.push(...(await validateImport(ctx, rows, data.duplicatePolicy)));
      const id = randomUUID();
      await ctx.tx.query(
        'INSERT INTO catalog_imports(id,branch_id,actor_id,rows,errors) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',
        [
          id,
          ctx.branchId,
          ctx.session.user.id,
          JSON.stringify(rows),
          JSON.stringify(errors),
        ],
      );
      await recordChange(
        ctx.tx,
        ctx.session.user.id,
        ctx.branchId,
        'import',
        id,
        1,
      );
      return { id, rows, errors };
    },
  );
  async function getImport({ tx, session, req, branchId }: Context) {
    return requireFound(
      (
        await tx.query<{
          id: string;
          rows: ImportRow[];
          errors: ImportError[];
          result: unknown;
          expired: boolean;
        }>(
          'SELECT id,rows,errors,result,expires_at<now() AS expired FROM catalog_imports WHERE id=$1 AND branch_id=$2 AND actor_id=$3 FOR UPDATE',
          [uuid.parse(req.params['id']), branchId, session.user.id],
        )
      ).rows[0],
    );
  }
  endpoint(
    'get',
    '/branches/:branchId/imports/:id',
    'catalog.manage',
    getImport,
  );
  endpoint(
    'get',
    '/branches/:branchId/imports/:id/errors',
    'catalog.manage',
    async (ctx) => {
      const data = await getImport(ctx);
      return {
        csv: csv([
          ['line', 'message'],
          ...data.errors.map((e) => [e.line, e.message]),
        ]),
      };
    },
  );
  endpoint(
    'post',
    '/branches/:branchId/imports/:id/commit',
    'catalog.manage',
    async (ctx) => {
      if (!ctx.session.permissions.includes('prices.manage'))
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Importing branch prices requires price permission.',
        );
      const data = await getImport(ctx);
      if (data.result) return data.result;
      if (data.expired || data.errors.length)
        throw new HttpError(
          409,
          'IMPORT_INVALID',
          'Stage a valid file again before committing.',
        );
      // Immutable skip decisions from preview; never turn a newly conflicting row into a silent skip.
      const accepted = data.rows.filter((row) => !row.skip);
      if ((await validateImport(ctx, accepted, 'reject')).length)
        throw new HttpError(
          409,
          'IMPORT_CHANGED',
          'Catalog changed since preview. Stage the file again.',
        );
      for (const row of accepted) {
        const unit = (
          await ctx.tx.query<{ id: string }>(
            'SELECT id FROM product_units WHERE name=$1',
            [row.unit],
          )
        ).rows[0]!;
        const result = await saveVariant(ctx, {
          productName: row.product_name,
          categoryId: null,
          brandId: null,
          sku: row.sku,
          name: row.variant_name,
          unitId: unit.id,
          conversion: row.conversion,
          fractional: row.fractional === 'true',
          minimumStock: row.minimum_stock,
          taxCodeId: null,
          barcodes: row.barcode ? [row.barcode] : [],
          archived: false,
        });
        await savePrice(ctx, result.id, row.price, 0);
      }
      const result = {
        id: data.id,
        imported: accepted.length,
        skipped: data.rows.length - accepted.length,
      };
      await ctx.tx.query(
        'UPDATE catalog_imports SET committed_at=now(),result=$2 WHERE id=$1',
        [data.id, result],
      );
      await recordChange(
        ctx.tx,
        ctx.session.user.id,
        ctx.branchId,
        'import',
        data.id,
        2,
      );
      return result;
    },
  );
}
