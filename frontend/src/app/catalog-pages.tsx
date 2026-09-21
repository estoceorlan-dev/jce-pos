import { useState } from 'react';
import {
  Editor,
  Grid,
  LoadState,
  Filters,
  History,
  archivedField,
  text,
  strings,
  type Row,
  type Field,
} from './forms';
import { useAllowed, useData, useSession } from './session';
type Lookups = { categories: Row[]; brands: Row[]; units: Row[]; taxes: Row[] };
const options = (rows: Row[] | undefined) =>
  (rows ?? []).map((row) => ({
    value: text(row['id']),
    label: text(row['name']) + (row['archived'] ? ' (archived)' : ''),
  }));
export function Catalog() {
  const { session, write } = useSession();
  const canManage = useAllowed('catalog.manage');
  const canPrice = useAllowed('prices.manage');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [archived, setArchived] = useState('false');
  const [editing, setEditing] = useState<Row | null>(null);
  const [pricing, setPricing] = useState<Row | null>(null);
  const [history, setHistory] = useState('');
  const base = `/branches/${session!.branchId}`;
  const query = useData<{ items: Row[]; hasMore: boolean }>(
    `${base}/catalog?${new URLSearchParams({ q, page: String(page), archived })}`,
  );
  const lookups = useData<Lookups>('/catalog/lookups');
  const fields: Field[] = [
    { key: 'productName', label: 'Product name' },
    { key: 'name', label: 'Variant name' },
    { key: 'sku', label: 'SKU' },
    {
      key: 'categoryId',
      label: 'Category',
      type: 'select',
      optional: true,
      options: options(lookups.data?.categories),
    },
    {
      key: 'brandId',
      label: 'Brand',
      type: 'select',
      optional: true,
      options: options(lookups.data?.brands),
    },
    {
      key: 'unitId',
      label: 'Base unit',
      type: 'select',
      options: options(lookups.data?.units),
    },
    {
      key: 'conversion',
      label: 'Base units per selling unit',
      hint: 'For example: 1 for a piece, 12 for a dozen.',
    },
    {
      key: 'fractional',
      label: 'Allow fractional selling quantities',
      type: 'checkbox',
    },
    { key: 'minimumStock', label: 'Low-stock threshold (selling units)' },
    {
      key: 'taxCodeId',
      label: 'Tax code',
      type: 'select',
      optional: true,
      options: options(lookups.data?.taxes),
    },
    {
      key: 'barcodes',
      label: 'Barcode aliases',
      type: 'textarea',
      optional: true,
      hint: 'One barcode per line.',
    },
    archivedField,
  ];
  const edit = (row: Row) =>
    setEditing({
      id: row['id'],
      productId: row['product_id'],
      productVersion: row['product_version'],
      version: row['version'],
      productName: row['product_name'],
      name: row['name'],
      sku: row['sku'],
      categoryId: row['category_id'],
      brandId: row['brand_id'],
      unitId: row['unit_id'],
      conversion: row['conversion'],
      fractional: row['fractional'],
      minimumStock: row['minimum_stock'],
      taxCodeId: row['tax_code_id'],
      barcodes: strings(row['barcodes']).join('\n'),
      archived: row['archived'],
    });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRODUCTS & PRICES</p>
          <h1>Catalog</h1>
          <p>Search or scan an item. Prices apply to the selected branch.</p>
        </div>
        {canManage && (
          <button
            onClick={() =>
              setEditing({
                conversion: '1',
                minimumStock: '0',
                fractional: false,
                archived: false,
              })
            }
          >
            Add product
          </button>
        )}
      </div>
      <LoadState query={lookups} />
      <Filters
        {...{ q, setQ, page, setPage, archived, setArchived }}
        hasMore={query.data?.hasMore ?? false}
      />
      <LoadState query={query} />
      {query.data && (
        <Grid
          title="Product variants"
          rows={query.data.items}
          columns={[
            ['sku', 'SKU'],
            ['product_name', 'Product'],
            ['name', 'Variant'],
            ['unit_name', 'Unit'],
            ['price', 'Price (PHP)'],
            ['archived', 'Archived'],
          ]}
          actions={(row) => (
            <div className="actions">
              {canManage && (
                <>
                  <button onClick={() => edit(row)}>
                    Edit {text(row['sku'])}
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      setEditing({
                        productId: row['product_id'],
                        productVersion: row['product_version'],
                        productName: row['product_name'],
                        categoryId: row['category_id'],
                        brandId: row['brand_id'],
                        unitId: row['unit_id'],
                        conversion: '1',
                        minimumStock: '0',
                        fractional: false,
                        archived: false,
                      })
                    }
                  >
                    Add variant
                  </button>
                </>
              )}
              {canPrice && (
                <button onClick={() => setPricing(row)}>Price</button>
              )}
              <button
                className="secondary"
                onClick={() => setHistory(text(row['id']))}
              >
                Price history
              </button>
            </div>
          )}
        />
      )}
      {editing && (
        <Editor
          key={text(editing['id']) || text(editing['productId']) || 'new'}
          title={editing['id'] ? 'Edit product variant' : 'New product variant'}
          fields={fields}
          initial={editing}
          done={() => setEditing(null)}
          save={async (data) => {
            const { id, ...values } = data;
            return write(
              `/catalog/variants${id ? '/' + text(id) : ''}`,
              {
                ...values,
                categoryId: values['categoryId'] || null,
                brandId: values['brandId'] || null,
                taxCodeId: values['taxCodeId'] || null,
                fractional: !!values['fractional'],
                archived: !!values['archived'],
                barcodes: text(values['barcodes'])
                  .split(/\r?\n/)
                  .map((v) => v.trim())
                  .filter(Boolean),
              },
              id ? 'PUT' : 'POST',
            );
          }}
        />
      )}
      {pricing && (
        <Editor
          key={text(pricing['id'])}
          title={`Branch price · ${text(pricing['sku'])}`}
          fields={[{ key: 'amount', label: 'Price (PHP)' }]}
          initial={{
            amount: pricing['price'] ?? '',
            version: pricing['price_version'] ?? 0,
          }}
          done={() => setPricing(null)}
          save={(data) =>
            write(`${base}/prices/${text(pricing['id'])}`, data, 'PUT')
          }
        />
      )}
      {history && (
        <History
          path={`${base}/prices/${history}/history`}
          title="Price history"
        />
      )}
    </>
  );
}
export function CatalogSetup() {
  const { write } = useSession();
  const query = useData<Lookups>('/catalog/lookups');
  const [kind, setKind] = useState<keyof Lookups>('units');
  const [editing, setEditing] = useState<Row | null>(null);
  const [history, setHistory] = useState('');
  const tax = useAllowed('settings.global');
  const manage = useAllowed('catalog.manage');
  const fields: Field[] =
    kind === 'taxes'
      ? [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'rate', label: 'Tax rate (fraction, 0 to 1)' },
          { key: 'inclusive', label: 'Tax inclusive', type: 'checkbox' },
          archivedField,
        ]
      : [
          { key: 'name', label: 'Name' },
          ...(kind === 'units'
            ? [
                {
                  key: 'fractional',
                  label: 'Fractional base quantities allowed',
                  type: 'checkbox',
                } as Field,
              ]
            : []),
          archivedField,
        ];
  return (
    <>
      <h1>Catalog setup</h1>
      <p>
        Catalog definitions are shared by all branches. Confirm tax treatment
        with the owner before use.
      </p>
      <div className="toolbar">
        <label>
          Record type
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as keyof Lookups);
              setEditing(null);
            }}
          >
            <option value="units">Units</option>
            <option value="categories">Categories</option>
            <option value="brands">Brands</option>
            <option value="taxes">Tax codes</option>
          </select>
        </label>
        {(kind === 'taxes' ? tax : manage) && (
          <button
            onClick={() =>
              setEditing({
                archived: false,
                ...(kind === 'units' ? { fractional: false } : {}),
                ...(kind === 'taxes' ? { inclusive: false } : {}),
              })
            }
          >
            Add record
          </button>
        )}
      </div>
      <LoadState query={query} />
      {query.data && (
        <Grid
          title={kind}
          rows={query.data[kind]}
          columns={[
            ['name', 'Name'],
            ...(kind === 'taxes' ? [['rate', 'Rate'] as [string, string]] : []),
            ['archived', 'Archived'],
          ]}
          actions={(row) => (
            <div className="actions">
              {(kind === 'taxes' ? tax : manage) && (
                <button onClick={() => setEditing(row)}>
                  Edit {text(row['name'])}
                </button>
              )}
              {kind === 'taxes' && tax && (
                <button onClick={() => setHistory(text(row['id']))}>
                  History
                </button>
              )}
            </div>
          )}
        />
      )}
      {editing && (
        <Editor
          key={kind + text(editing['id'])}
          title={`Edit ${kind}`}
          fields={fields}
          initial={editing}
          done={() => setEditing(null)}
          save={(data) => {
            const { id, ...values } = data;
            return write(
              `/catalog/${kind}${id ? '/' + text(id) : ''}`,
              values,
              id ? 'PUT' : 'POST',
            );
          }}
        />
      )}
      {history && tax && <History path={`/catalog/taxes/${history}/history`} />}
    </>
  );
}
export function Partners({ kind }: { kind: 'customers' | 'suppliers' }) {
  const { session, write } = useSession();
  const canManage = useAllowed('partners.manage');
  const contacts = useAllowed('contacts.read');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [archived, setArchived] = useState('false');
  const [editing, setEditing] = useState<Row | null>(null);
  const [history, setHistory] = useState('');
  const [selected, setSelected] = useState('Walk-in');
  const base = `/branches/${session!.branchId}/${kind}`;
  const params = new URLSearchParams({ q, page: String(page), archived });
  const query = useData<{ items: Row[]; hasMore: boolean }>(
    `${base}?${params}`,
  );
  return (
    <>
      <h1>{kind === 'customers' ? 'Customers' : 'Suppliers'}</h1>
      {kind === 'customers' && (
        <div className="card">
          <p>
            Customer selection: <strong>{selected}</strong>
          </p>
          <button className="secondary" onClick={() => setSelected('Walk-in')}>
            Use walk-in customer
          </button>
          <p>
            No customer record is required for walk-in sales. Checkout becomes
            available after inventory setup.
          </p>
        </div>
      )}
      <div className="toolbar">
        {canManage && (
          <button onClick={() => setEditing({ contact: '', archived: false })}>
            Add {kind === 'customers' ? 'customer' : 'supplier'}
          </button>
        )}
        <a
          className="button secondary"
          href={`/api/v1${base}/export?${params}`}
        >
          Export current page
        </a>
      </div>
      <Filters
        {...{ q, setQ, page, setPage, archived, setArchived }}
        hasMore={query.data?.hasMore ?? false}
      />
      <LoadState query={query} />
      {query.data && (
        <Grid
          title={kind}
          rows={query.data.items}
          columns={[
            ['name', 'Name'],
            ...(contacts ? [['contact', 'Contact'] as [string, string]] : []),
            ['archived', 'Archived'],
          ]}
          actions={(row) => (
            <div className="actions">
              {canManage && (
                <button
                  onClick={() =>
                    setEditing({ ...row, contact: row['contact'] ?? '' })
                  }
                >
                  Edit {text(row['name'])}
                </button>
              )}
              {kind === 'customers' && (
                <>
                  <button onClick={() => setSelected(text(row['name']))}>
                    Select
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setHistory(text(row['id']))}
                  >
                    History
                  </button>
                </>
              )}
            </div>
          )}
        />
      )}
      {editing && (
        <Editor
          key={text(editing['id']) || 'new'}
          title={kind === 'customers' ? 'Customer details' : 'Supplier details'}
          fields={[
            { key: 'name', label: 'Name' },
            ...(contacts
              ? [
                  {
                    key: 'contact',
                    label: 'Contact information',
                    type: 'textarea',
                    optional: true,
                  } as Field,
                ]
              : []),
            archivedField,
          ]}
          initial={editing}
          done={() => setEditing(null)}
          save={(data) => {
            const { id, ...values } = data;
            return write(
              `${base}${id ? '/' + text(id) : ''}`,
              values,
              id ? 'PUT' : 'POST',
            );
          }}
        />
      )}
      {history && (
        <>
          <p>
            Posted sales and refunds will appear here when checkout and returns
            are available.
          </p>
          <History
            path={`${base}/${history}/history`}
            title="Customer history"
          />
        </>
      )}
    </>
  );
}
export function ImportCatalog() {
  const { session, write } = useSession();
  const [file, setFile] = useState('');
  const [policy, setPolicy] = useState('reject');
  const [stage, setStage] = useState<{
    id: string;
    rows: Row[];
    errors: Row[];
  } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/branches/${session!.branchId}/imports`;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>Import catalog</h1>
      <p>
        Up to 500 rows per file. Create units first. Preview and confirm
        products and branch prices; opening stock is handled separately.
      </p>
      <a className="button secondary" href="/api/v1/catalog/import-template">
        Download CSV template
      </a>
      <section className="record-form">
        <label>
          CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              setStage(null);
              setMessage('');
              const chosen = e.target.files?.[0];
              if (chosen) {
                if (chosen.size > 50000) {
                  setFile('');
                  setError('Choose a CSV under 50 KB.');
                } else void chosen.text().then(setFile);
              } else setFile('');
            }}
          />
        </label>
        <label>
          Duplicate policy
          <select
            value={policy}
            onChange={(e) => {
              setPolicy(e.target.value);
              setStage(null);
            }}
          >
            <option value="reject">Reject duplicates</option>
            <option value="skip">Skip existing or repeated codes</option>
          </select>
        </label>
        <button
          disabled={!file || busy}
          onClick={() =>
            void run(async () => {
              setStage(
                await write(base, { csv: file, duplicatePolicy: policy }),
              );
              setMessage('Review every row before committing.');
            })
          }
        >
          Preview import
        </button>
      </section>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {stage && (
        <>
          <Grid
            title="Import preview"
            rows={stage.rows}
            columns={[
              ['line', 'Row'],
              ['sku', 'SKU'],
              ['product_name', 'Product'],
              ['unit', 'Unit'],
              ['price', 'Price (PHP)'],
              ['skip', 'Skip'],
            ]}
          />
          <Grid
            title="Validation errors"
            rows={stage.errors}
            columns={[
              ['line', 'Row'],
              ['message', 'Error'],
            ]}
          />
          <div className="actions">
            <a
              className="button secondary"
              href={`/api/v1${base}/${stage.id}/errors`}
            >
              Download error report
            </a>
            <button
              disabled={busy || stage.errors.length > 0}
              onClick={() =>
                void run(async () => {
                  const result = await write<{
                    imported: number;
                    skipped: number;
                  }>(`${base}/${stage.id}/commit`, {});
                  setMessage(
                    `Import committed: ${result.imported} added, ${result.skipped} skipped.`,
                  );
                })
              }
            >
              Commit reviewed import
            </button>
          </div>
        </>
      )}
    </>
  );
}
