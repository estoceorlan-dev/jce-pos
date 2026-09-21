import { useId, useState, type ReactNode } from 'react';
import { DataTable, StatePanel } from '../components/ui';
import { useData } from './session';
export type Row = Record<string, unknown>;
export const text = (value: unknown) => (value == null ? '' : String(value));
export const strings = (value: unknown) =>
  Array.isArray(value) ? value.map(text) : [];
export type Field = {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'checkbox' | 'select' | 'multi' | 'textarea';
  options?: { value: string; label: string }[];
  optional?: boolean;
  hint?: string;
};
export function Editor({
  title,
  fields,
  initial = {},
  save,
  done,
  submit = 'Save',
}: {
  title: string;
  fields: Field[];
  initial?: Row;
  save: (data: Row) => Promise<unknown>;
  done?: () => void;
  submit?: string;
}) {
  const id = useId();
  const [data, setData] = useState<Row>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        setSaved(false);
        void save(data)
          .then(() => {
            setSaved(true);
            done?.();
          })
          .catch((e: unknown) =>
            setError(e instanceof Error ? e.message : 'Save failed.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      <h2>{title}</h2>
      <div className="form-grid">
        {fields.map((field) => (
          <div
            className={`field ${field.type === 'multi' || field.type === 'textarea' ? 'wide' : ''}`}
            key={field.key}
          >
            <label htmlFor={`${id}-${field.key}`}>{field.label}</label>
            {field.type === 'select' ? (
              <select
                id={`${id}-${field.key}`}
                required={!field.optional}
                value={text(data[field.key])}
                onChange={(e) =>
                  setData({ ...data, [field.key]: e.target.value })
                }
              >
                <option value="">Select…</option>
                {field.options?.map((o) => (
                  <option value={o.value} key={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'multi' ? (
              <div
                className="check-options"
                id={`${id}-${field.key}`}
                role="group"
                aria-label={field.label}
              >
                {field.options?.map((o) => (
                  <label key={o.value}>
                    <input
                      type="checkbox"
                      checked={strings(data[field.key]).includes(o.value)}
                      onChange={(e) =>
                        setData({
                          ...data,
                          [field.key]: e.target.checked
                            ? [...strings(data[field.key]), o.value]
                            : strings(data[field.key]).filter(
                                (v) => v !== o.value,
                              ),
                        })
                      }
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            ) : field.type === 'checkbox' ? (
              <input
                id={`${id}-${field.key}`}
                type="checkbox"
                checked={Boolean(data[field.key])}
                onChange={(e) =>
                  setData({ ...data, [field.key]: e.target.checked })
                }
              />
            ) : field.type === 'textarea' ? (
              <textarea
                id={`${id}-${field.key}`}
                required={!field.optional}
                value={text(data[field.key])}
                onChange={(e) =>
                  setData({ ...data, [field.key]: e.target.value })
                }
              />
            ) : (
              <input
                id={`${id}-${field.key}`}
                type={field.type ?? 'text'}
                required={!field.optional}
                autoComplete={
                  field.type === 'password' ? 'new-password' : 'off'
                }
                maxLength={field.type === 'password' ? 128 : 500}
                value={text(data[field.key])}
                onChange={(e) =>
                  setData({ ...data, [field.key]: e.target.value })
                }
              />
            )}
            {field.hint && <small>{field.hint}</small>}
          </div>
        ))}
      </div>
      <div className="actions">
        <button disabled={busy}>{busy ? 'Saving…' : submit}</button>
        {done && (
          <button type="button" className="secondary" onClick={done}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {saved && <p role="status">Saved.</p>}
    </form>
  );
}
export function LoadState({
  query,
}: {
  query: { isPending: boolean; error: Error | null; refetch: () => unknown };
}) {
  if (query.isPending)
    return <StatePanel title="Loading records">Please wait.</StatePanel>;
  if (query.error)
    return (
      <StatePanel
        title="Could not load records"
        error
        action={<button onClick={() => void query.refetch()}>Try again</button>}
      >
        {query.error.message}
      </StatePanel>
    );
  return null;
}
export function Grid({
  title,
  rows,
  columns,
  actions,
}: {
  title: string;
  rows: Row[];
  columns: [string, string][];
  actions?: (row: Row) => ReactNode;
}) {
  return (
    <DataTable
      caption={title}
      columns={[...columns.map((c) => c[1]), ...(actions ? ['Actions'] : [])]}
      rows={rows.map((row) => [
        ...columns.map(([key]) =>
          Array.isArray(row[key])
            ? strings(row[key]).join(', ')
            : typeof row[key] === 'boolean'
              ? row[key]
                ? 'Yes'
                : 'No'
              : text(row[key]),
        ),
        ...(actions ? [actions(row)] : []),
      ])}
    />
  );
}
export function History({
  path,
  title = 'Change history',
}: {
  path: string;
  title?: string;
}) {
  const query = useData<Row[]>(path);
  return (
    <section className="card history">
      <h2>{title}</h2>
      <LoadState query={query} />
      {query.data && (
        <Grid
          title={title}
          rows={query.data.map((row) => ({
            ...row,
            details: row['value']
              ? Object.entries(row['value'] as Row)
                  .map(([k, v]) => `${k}: ${text(v)}`)
                  .join(' · ')
              : text(row['amount'] ?? row['source_id'] ?? row['username']),
            occurred_at: new Date(text(row['occurred_at'])).toLocaleString(
              'en-PH',
              { timeZone: 'Asia/Manila' },
            ),
          }))}
          columns={[
            ['occurred_at', 'Date (Manila)'],
            ['version', 'Version'],
            ['details', 'Details'],
            ...(path.includes('login-history')
              ? [['success', 'Successful'] as [string, string]]
              : []),
          ]}
        />
      )}
    </section>
  );
}
export function Filters({
  q,
  setQ,
  page,
  setPage,
  archived,
  setArchived,
  hasMore,
}: {
  q: string;
  setQ: (v: string) => void;
  page: number;
  setPage: (v: number) => void;
  archived: string;
  setArchived: (v: string) => void;
  hasMore: boolean;
}) {
  return (
    <div className="toolbar">
      <label>
        Search
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="Name, SKU or barcode"
          maxLength={100}
        />
      </label>
      <label>
        Status
        <select
          value={archived}
          onChange={(e) => {
            setArchived(e.target.value);
            setPage(1);
          }}
        >
          <option value="false">Active</option>
          <option value="true">Archived</option>
          <option value="all">All records</option>
        </select>
      </label>
      <button disabled={page === 1} onClick={() => setPage(page - 1)}>
        Previous
      </button>
      <span>Page {page}</span>
      <button disabled={!hasMore} onClick={() => setPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
export const archivedField: Field = {
  key: 'archived',
  label: 'Archived',
  type: 'checkbox',
};
