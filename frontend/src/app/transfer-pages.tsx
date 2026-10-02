import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import {
  transferInput,
  stockQuantity,
  transferStatuses,
  type TransferInput,
} from '@jce/shared';
import { api, ApiError, useData, useSession } from './session';
import { Grid, LoadState, text, type Row } from './forms';

type Line = {
  id: string;
  variant_id: string;
  quantity: string;
  snapshot: { name: string; sku: string; unit: string };
};
type Document = {
  transfer: Row;
  lines: Line[];
  ledger: Row[];
  receipts: Row[];
  receiptItems: Row[];
  discrepancies: Row[];
  events: Row[];
  shipment: Row | null;
  returns: Row[];
};
type Draft = {
  id?: string;
  version?: number;
  transfer: TransferInput;
  names: Record<string, string>;
};
const pendingSchema = z.object({
  path: z.string(),
  method: z.enum(['POST', 'PUT']),
  body: z.record(z.string(), z.unknown()),
  password: z.boolean(),
  transferId: z.string(),
});
type Pending = z.infer<typeof pendingSchema>;
type Mutate = (
  suffix: string,
  body: Row,
  password?: string,
  method?: 'POST' | 'PUT',
) => Promise<void>;
const label = (s: unknown) => text(s).replaceAll('_', ' ');
const date = (s: unknown) =>
  s
    ? new Date(text(s)).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })
    : '';
const conditions = ['sellable', 'damaged', 'quarantined'];

export function Transfers() {
  const { session } = useSession();
  return <TransferWorkspace key={`${session!.user.id}:${session!.branchId}`} />;
}
function TransferWorkspace() {
  const { session, refresh } = useSession();
  const [params, setParams] = useSearchParams();
  const selected = params.get('transfer') ?? '';
  const base = `/branches/${session!.branchId}/transfers`;
  const storage = `transfer-action:${session!.user.id}:${session!.branchId}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      const parsed = pendingSchema.safeParse(
        JSON.parse(localStorage.getItem(storage) ?? 'null'),
      );
      return parsed.success && parsed.data.path.startsWith(base)
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    inFlight = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [q, setQ] = useState(''),
    [status, setStatus] = useState('all'),
    [direction, setDirection] = useState('all'),
    [page, setPage] = useState(1);
  const list = useData<{ rows: Row[]; hasMore: boolean }>(
    `${base}?q=${encodeURIComponent(q)}&status=${status}&direction=${direction}&page=${page}`,
  );
  const can = (p: string) => session!.permissions.includes(`transfers.${p}`);
  const open = (id: string) => {
    setParams({ transfer: id });
    setDraft(null);
  };
  const send = async (saved: Pending, confirmation = '') => {
    if (inFlight.current)
      throw new Error('Wait for the current transfer action.');
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      // Save the exact request before transmission. Passwords are never stored.
      localStorage.setItem(storage, JSON.stringify(saved));
      setPending(saved);
      const result = await api<{ id: string; transferId?: string }>(
        saved.path,
        saved.method,
        {
          ...saved.body,
          ...(saved.password ? { password: confirmation } : {}),
        },
        session!.csrfToken,
      );
      localStorage.removeItem(storage);
      setPending(null);
      setPassword('');
      open(result.transferId || saved.transferId || result.id);
      await refresh();
    } catch (e) {
      if (
        e instanceof ApiError &&
        [400, 404, 409, 422].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT'
      ) {
        localStorage.removeItem(storage);
        setPending(null);
        await refresh();
      }
      setError(e instanceof Error ? e.message : 'Transfer action failed.');
      throw e;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const mutate: Mutate = async (
    suffix,
    body,
    confirmation,
    method = 'POST',
  ) => {
    if (pending) throw new Error('Recover the saved transfer action first.');
    await send(
      {
        path: base + suffix,
        method,
        body: { ...body, requestKey: crypto.randomUUID() },
        password: confirmation !== undefined,
        transferId: suffix.split('/')[1] ?? '',
      },
      confirmation,
    );
  };
  return (
    <div className="purchase-page inventory-page">
      <h1>Branch transfers</h1>
      <p>
        Transfers are available only between branches in this local
        installation. Transfers between independent installations are
        unavailable.
      </p>
      <p>
        Every transfer requires a different source reviewer. Approval reserves
        stock; dispatch moves it into transit. Short receipts remain open until
        received or independently resolved.
      </p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {pending && (
        <section className="card no-print" aria-label="Saved transfer action">
          <h2>Recover saved transfer action</h2>
          <p>
            The result may already be committed. Retry this exact action to
            retrieve its result before starting another action.
          </p>
          <p>
            Action: {pending.method}{' '}
            {pending.path.split('/transfers')[1] || ' / new draft'}
          </p>
          {pending.password && (
            <label>
              Retry confirmation password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          <button
            disabled={busy || (pending.password && !password)}
            onClick={() => void send(pending, password).catch(() => undefined)}
          >
            Retry saved transfer action
          </button>
        </section>
      )}
      <div className="toolbar no-print">
        <label>
          Transfer number
          <input
            maxLength={100}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Transfer status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            {['all', ...transferStatuses].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value);
              setPage(1);
            }}
          >
            {['all', 'outbound', 'inbound'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        {can('manage') && (
          <button
            disabled={busy || !!pending}
            onClick={() =>
              setDraft({
                transfer: {
                  destinationBranchId: '',
                  returnOfId: null,
                  note: '',
                  lines: [],
                },
                names: {},
              })
            }
          >
            New transfer
          </button>
        )}
      </div>
      <LoadState query={list} />
      {list.data && (
        <Grid
          title="Transfers"
          rows={list.data.rows.map((r) => ({
            ...r,
            status: label(r['status']),
          }))}
          columns={[
            ['number', 'Number'],
            ['source', 'Source'],
            ['destination', 'Destination'],
            ['status', 'Status'],
          ]}
          actions={(r) => (
            <button onClick={() => open(text(r['id']))}>
              Open {text(r['number'])}
            </button>
          )}
        />
      )}
      <div className="actions no-print">
        <button disabled={page === 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>Page {page}</span>
        <button
          disabled={!list.data?.hasMore}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
      {draft && (
        <DraftEditor
          key={draft.id ?? draft.transfer.returnOfId ?? 'new'}
          base={base}
          draft={draft}
          busy={busy || !!pending}
          mutate={mutate}
          close={() => setDraft(null)}
        />
      )}
      {selected && !draft && (
        <TransferDetail
          key={selected}
          id={selected}
          base={base}
          blocked={busy || !!pending}
          mutate={mutate}
          edit={setDraft}
          open={open}
        />
      )}
    </div>
  );
}
function DraftEditor({
  base,
  draft,
  busy,
  mutate,
  close,
}: {
  base: string;
  draft: Draft;
  busy: boolean;
  mutate: Mutate;
  close: () => void;
}) {
  const [data, setData] = useState(draft.transfer),
    [names, setNames] = useState(draft.names),
    [search, setSearch] = useState(''),
    [error, setError] = useState('');
  const options = useData<{ branches: Row[]; variants: Row[] }>(
    `${base}/options?q=${encodeURIComponent(search)}`,
  );
  return (
    <form
      className="record-form no-print"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        const parsed = transferInput.safeParse(data);
        if (!parsed.success) {
          setError(
            'Choose a destination, add unique products with positive quantities, and enter a reason.',
          );
          return;
        }
        void mutate(
          draft.id ? `/${draft.id}` : '',
          {
            transfer: parsed.data,
            ...(draft.id ? { version: draft.version } : {}),
          },
          undefined,
          draft.id ? 'PUT' : 'POST',
        ).catch((e) =>
          setError(e instanceof Error ? e.message : 'Save failed.'),
        );
      }}
    >
      <h2>
        {draft.id
          ? 'Edit transfer draft'
          : data.returnOfId
            ? 'New linked return transfer'
            : 'New transfer draft'}
      </h2>
      <fieldset disabled={busy}>
        <div className="form-grid">
          <label>
            Destination branch
            <select
              aria-label="Destination branch"
              required
              value={data.destinationBranchId}
              disabled={!!draft.id || !!data.returnOfId}
              onChange={(e) =>
                setData({ ...data, destinationBranchId: e.target.value })
              }
            >
              <option value="">Select destination</option>
              {options.data?.branches.map((b) => (
                <option key={text(b['id'])} value={text(b['id'])}>
                  {text(b['name'])} ({text(b['code'])})
                </option>
              ))}
            </select>
          </label>
          <label>
            Transfer reason
            <textarea
              required
              maxLength={500}
              value={data.note}
              onChange={(e) => setData({ ...data, note: e.target.value })}
            />
          </label>
          <label>
            Find transfer product
            <input
              maxLength={100}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <LoadState query={options} />
        <label>
          Add product
          <select
            aria-label="Add product"
            value=""
            onChange={(e) => {
              const v = options.data?.variants.find(
                (v) => v['id'] === e.target.value,
              );
              if (!v || data.lines.some((l) => l.variantId === v['id'])) return;
              setNames({
                ...names,
                [text(v['id'])]: `${text(v['sku'])} — ${text(v['name'])}`,
              });
              setData({
                ...data,
                lines: [
                  ...data.lines,
                  { variantId: text(v['id']), quantity: '1' },
                ],
              });
            }}
          >
            <option value="">Select a product (first 100 matches)</option>
            {options.data?.variants.map((v) => (
              <option
                disabled={
                  data.lines.some((l) => l.variantId === v['id']) ||
                  data.lines.length >= 100
                }
                key={text(v['id'])}
                value={text(v['id'])}
              >
                {text(v['sku'])} — {text(v['name'])}
              </option>
            ))}
          </select>
        </label>
        <p>
          Enter quantities in base units. Pack conversions are not applied to
          these quantities.
        </p>
        {data.lines.map((l, i) => (
          <div className="toolbar" key={l.variantId}>
            <label>
              {names[l.variantId] ?? l.variantId}
              <input
                aria-label={`Draft quantity ${i + 1}`}
                required
                inputMode="decimal"
                value={l.quantity}
                onChange={(e) =>
                  setData({
                    ...data,
                    lines: data.lines.map((x, n) =>
                      n === i ? { ...x, quantity: e.target.value } : x,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                setData({
                  ...data,
                  lines: data.lines.filter((_, n) => n !== i),
                })
              }
            >
              Remove item {i + 1}
            </button>
          </div>
        ))}
        <div className="actions">
          <button>Save transfer draft</button>
          <button type="button" className="secondary" onClick={close}>
            Close editor
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </form>
  );
}
function TransferDetail({
  id,
  base,
  blocked,
  mutate,
  edit,
  open,
}: {
  id: string;
  base: string;
  blocked: boolean;
  mutate: Mutate;
  edit: (d: Draft) => void;
  open: (id: string) => void;
}) {
  const query = useData<Document>(`${base}/${id}`);
  return (
    <>
      <LoadState query={query} />
      {query.data && (
        <TransferView
          key={`${id}:${text(query.data.transfer['version'])}`}
          data={query.data}
          blocked={blocked}
          mutate={mutate}
          edit={edit}
          open={open}
        />
      )}
    </>
  );
}
function TransferView({
  data,
  blocked,
  mutate,
  edit,
  open,
}: {
  data: Document;
  blocked: boolean;
  mutate: Mutate;
  edit: (d: Draft) => void;
  open: (id: string) => void;
}) {
  const { session } = useSession();
  const t = data.transfer,
    id = text(t['id']),
    status = text(t['status']),
    version = Number(t['version']);
  const source = t['source_branch_id'] === session!.branchId,
    destination = t['destination_branch_id'] === session!.branchId,
    author = t['actor_id'] === session!.user.id;
  const can = (p: string) => session!.permissions.includes(`transfers.${p}`);
  const [note, setNote] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState('');
  const snapshot = t['snapshot'] as {
    source: { name: string; code: string };
    destination: { name: string; code: string };
    returnOfNumber: string | null;
  };
  const inTransit = ['in_transit', 'partially_received'].includes(status);
  const request = async (action: string, confirmation?: string) => {
    setError('');
    if (!note.trim()) {
      setError('Enter an action reason.');
      return;
    }
    try {
      await mutate(`/${id}/${action}`, { version, note }, confirmation);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    }
  };
  const names = Object.fromEntries(
    data.lines.map((l) => [
      l.variant_id,
      `${l.snapshot.sku} — ${l.snapshot.name}`,
    ]),
  );
  const lineName = (r: Row) => {
    const l = data.lines.find((l) => l.id === r['transfer_item_id']);
    return l ? `${l.snapshot.sku} — ${l.snapshot.name}` : '';
  };
  const rows: Row[] = data.ledger.map((r) => ({ ...r, product: lineName(r) }));
  const closedDiscrepancy =
    status === 'received' &&
    rows.some(
      (r) =>
        Number(r['lost_quantity']) > 0 || Number(r['returned_quantity']) > 0,
    );
  return (
    <>
      <section className="card no-print">
        <h2>Transfer actions</h2>
        <p>
          Selected: {text(t['number'])} · {label(status)} · version {version}
        </p>
        {!blocked && (
          <fieldset>
            <div className="form-grid">
              <label>
                Action reason
                <textarea
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              {((source && status === 'pending' && can('approve') && !author) ||
                (destination && inTransit && can('resolve'))) && (
                <label>
                  Confirmation password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}
            </div>
            <div className="actions">
              {source && author && can('manage') && status === 'draft' && (
                <>
                  <button
                    onClick={() =>
                      edit({
                        id,
                        version,
                        transfer: {
                          destinationBranchId: text(t['destination_branch_id']),
                          returnOfId: t['return_of_id']
                            ? text(t['return_of_id'])
                            : null,
                          note: text(t['note']),
                          lines: data.lines.map((l) => ({
                            variantId: l.variant_id,
                            quantity: l.quantity,
                          })),
                        },
                        names,
                      })
                    }
                  >
                    Edit draft
                  </button>
                  <button onClick={() => void request('submit')}>
                    Submit for approval
                  </button>
                </>
              )}
              {source &&
                author &&
                can('manage') &&
                ['draft', 'pending', 'approved'].includes(status) && (
                  <button onClick={() => void request('cancel')}>
                    Cancel before shipment
                  </button>
                )}
              {source && !author && can('approve') && status === 'pending' && (
                <>
                  <button
                    disabled={!password}
                    onClick={() => void request('approve', password)}
                  >
                    Approve and reserve
                  </button>
                  <button
                    disabled={!password}
                    onClick={() => void request('reject', password)}
                  >
                    Reject transfer
                  </button>
                </>
              )}
              {source && can('dispatch') && status === 'approved' && (
                <button onClick={() => void request('dispatch')}>
                  Dispatch transfer
                </button>
              )}
              {destination &&
                can('manage') &&
                !t['return_of_id'] &&
                data.receiptItems.some(
                  (r) => r['condition'] === 'sellable',
                ) && (
                  <button
                    onClick={() =>
                      edit({
                        transfer: {
                          destinationBranchId: text(t['source_branch_id']),
                          returnOfId: id,
                          note: `Return against ${text(t['number'])}`,
                          lines: [],
                        },
                        names,
                      })
                    }
                  >
                    Create linked return transfer
                  </button>
                )}
              <button className="secondary" onClick={() => window.print()}>
                Print transfer slip
              </button>
            </div>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        {source && author && status === 'pending' && (
          <p>A different source-branch reviewer must approve this transfer.</p>
        )}
        {inTransit && (
          <p>
            Dispatched transfers cannot be cancelled. Receive actual stock or
            propose a discrepancy for the remaining transit stock.
          </p>
        )}
      </section>
      {destination && inTransit && can('receive') && !blocked && (
        <ReceiptEditor data={data} mutate={mutate} />
      )}
      <section className="purchase-print card" aria-label="Transfer slip">
        <h2>Transfer slip · {text(t['number'])}</h2>
        <p>
          <strong>
            {closedDiscrepancy ? 'Closed with discrepancy' : label(status)}
          </strong>{' '}
          · version {version}
        </p>
        <p>
          {snapshot.source.name} ({snapshot.source.code}) →{' '}
          {snapshot.destination.name} ({snapshot.destination.code})
        </p>
        <p>{text(t['note'])}</p>
        {!!t['return_of_id'] && (
          <p>
            Linked return of{' '}
            <button
              className="secondary"
              onClick={() => open(text(t['return_of_id']))}
            >
              {snapshot.returnOfNumber}
            </button>
          </p>
        )}
        <p>
          Created {date(t['created_at'])} (Manila).{' '}
          {data.shipment
            ? `Dispatched ${date(data.shipment['dispatched_at'])} by ${text(data.shipment['actor'])}.`
            : 'Not dispatched; no stock has moved.'}
        </p>
        <Grid
          title="Transfer quantities (base units)"
          rows={data.lines.map((l) => ({
            sku: l.snapshot.sku,
            product: l.snapshot.name,
            unit: l.snapshot.unit,
            quantity: l.quantity,
          }))}
          columns={[
            ['sku', 'SKU'],
            ['product', 'Product'],
            ['unit', 'Unit'],
            ['quantity', 'Requested base units'],
          ]}
        />
        <Grid
          title="Quantity conservation"
          rows={rows}
          columns={[
            ['product', 'Product'],
            ['shipped_quantity', 'Shipped'],
            ['received_quantity', 'Received'],
            ['lost_quantity', 'Loss'],
            ['returned_quantity', 'Returned to source'],
            ['transit_quantity', 'In transit'],
            ['matched', 'Reconciled'],
          ]}
        />
        <Grid
          title="Value conservation (PHP)"
          rows={rows}
          columns={[
            ['product', 'Product'],
            ['shipped_value', 'Dispatch value'],
            ['received_value', 'Received value'],
            ['lost_value', 'Loss value'],
            ['returned_value', 'Returned value'],
            ['transit_value', 'Transit value'],
          ]}
        />
        {data.receipts.map((r) => (
          <section key={text(r['id'])}>
            <h3>Receipt {text(r['number'])}</h3>
            <p>
              {date(r['posted_at'])} · {text(r['actor'])} · {text(r['note'])}
            </p>
            <Grid
              title={`Receipt lines ${text(r['number'])}`}
              rows={data.receiptItems
                .filter((l) => l['receipt_id'] === r['id'])
                .map((l) => ({ ...l, product: lineName(l) }))}
              columns={[
                ['product', 'Product'],
                ['quantity', 'Actual base units'],
                ['condition', 'Condition'],
                ['value', 'Value (PHP)'],
              ]}
            />
          </section>
        ))}
        <h3>Discrepancy review</h3>
        {!data.discrepancies.length && <p>No discrepancy proposals.</p>}
        {data.discrepancies.map((d) => {
          const stale =
            d['status'] === 'pending' &&
            Number(d['transfer_version']) !== version;
          const input = d['input'] as {
            lines: { transferItemId: string; resolution: string }[];
          };
          const quote = d['quote'] as Row[];
          return (
            <section key={text(d['id'])} className="card">
              <h4>
                {label(d['reason_code'])} ·{' '}
                {stale ? 'Stale proposal' : label(d['status'])}
              </h4>
              <p>
                {text(d['note'])} · Requested by {text(d['actor'])} at{' '}
                {date(d['created_at'])}
                {d['approver']
                  ? ` · Reviewed by ${text(d['approver'])} at ${date(d['posted_at'])}`
                  : ''}
              </p>
              <Grid
                title="Exact discrepancy proposal"
                rows={quote.map((l) => ({
                  ...l,
                  resolution: label(
                    input.lines.find(
                      (i) => i.transferItemId === l['transferItemId'],
                    )?.resolution,
                  ),
                }))}
                columns={[
                  ['name', 'Product'],
                  ['quantity', 'Base units'],
                  ['value', 'Value (PHP)'],
                  ['resolution', 'Resolution'],
                  ['condition', 'Return condition'],
                ]}
              />
              {destination &&
                can('resolve') &&
                inTransit &&
                d['status'] === 'pending' &&
                !stale &&
                d['actor_id'] !== session!.user.id &&
                !blocked && (
                  <button
                    className="no-print"
                    disabled={!password}
                    onClick={() =>
                      void request(
                        `discrepancies/${text(d['id'])}/resolve`,
                        password,
                      )
                    }
                  >
                    Confirm discrepancy resolution
                  </button>
                )}
              {d['status'] === 'pending' && !stale && (
                <p className="no-print">
                  A different destination reviewer confirms the exact quantities
                  and values with their password. Returning goods to source also
                  requires that reviewer’s source-branch resolution permission.
                </p>
              )}
            </section>
          );
        })}
        {data.returns.length > 0 && (
          <Grid
            title="Linked return transfers"
            rows={data.returns}
            columns={[
              ['number', 'Number'],
              ['status', 'Status'],
            ]}
            actions={(r) => (
              <button onClick={() => open(text(r['id']))}>
                Open return transfer
              </button>
            )}
          />
        )}
        <Grid
          title="Transfer history (Manila)"
          rows={data.events.map((r) => ({
            ...r,
            occurred_at: date(r['occurred_at']),
            action: label(r['action']),
          }))}
          columns={[
            ['version', 'Version'],
            ['occurred_at', 'Time'],
            ['action', 'Action'],
            ['actor', 'User'],
            ['note', 'Reason'],
          ]}
        />
      </section>
    </>
  );
}
function ReceiptEditor({ data, mutate }: { data: Document; mutate: Mutate }) {
  const [mode, setMode] = useState('receipt'),
    [note, setNote] = useState(''),
    [reason, setReason] = useState('MISSING'),
    [error, setError] = useState('');
  const [entries, setEntries] = useState(() =>
    data.lines
      .filter((l) =>
        data.ledger.some(
          (r) =>
            r['transfer_item_id'] === l.id && Number(r['transit_quantity']) > 0,
        ),
      )
      .map((l) => ({
        transferItemId: l.id,
        quantity: '0',
        condition: 'sellable',
        resolution: 'lost',
      })),
  );
  const change = (i: number, k: string, v: string) =>
    setEntries(entries.map((l, n) => (n === i ? { ...l, [k]: v } : l)));
  return (
    <form
      className="record-form no-print"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        if (entries.some((l) => !stockQuantity.safeParse(l.quantity).success)) {
          setError(
            'Use nonnegative base-unit quantities with at most six decimal places.',
          );
          return;
        }
        const lines = entries
          .filter((l) => Number(l.quantity) > 0)
          .map((l) =>
            mode === 'receipt'
              ? {
                  transferItemId: l.transferItemId,
                  quantity: l.quantity,
                  condition: l.condition,
                }
              : l,
          );
        if (!lines.length) {
          setError('Enter an actual quantity for at least one item.');
          return;
        }
        void mutate(
          `/${text(data.transfer['id'])}/${mode === 'receipt' ? 'receive' : 'discrepancies'}`,
          {
            version: data.transfer['version'],
            note,
            lines,
            ...(mode === 'receipt' ? {} : { reasonCode: reason }),
          },
        ).catch((e) =>
          setError(e instanceof Error ? e.message : 'Action failed.'),
        );
      }}
    >
      <h2>Receive or resolve transit stock</h2>
      <div className="form-grid">
        <label>
          Transit action
          <select
            aria-label="Transit action"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="receipt">Receive actual stock</option>
            <option value="discrepancy">Propose discrepancy</option>
          </select>
        </label>
        <label>
          Receipt or discrepancy reason
          <textarea
            required
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {mode === 'discrepancy' && (
          <label>
            Discrepancy reason code
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {['MISSING', 'DAMAGED', 'RETURN_TO_SOURCE'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p>
        Enter only the actual base-unit quantities. Leave other lines at zero.
        Damaged or quarantined receipts keep their inventory value; a loss
        resolution explicitly removes value from transit.
      </p>
      {entries.map((entry, i) => {
        const l = data.lines.find((l) => l.id === entry.transferItemId)!;
        const remaining = data.ledger.find(
          (r) => r['transfer_item_id'] === l.id,
        )!;
        return (
          <div className="form-grid" key={l.id}>
            <label>
              {l.snapshot.sku} — {l.snapshot.name} (remaining{' '}
              {text(remaining['transit_quantity'])})
              <input
                aria-label={`Actual quantity ${i + 1}`}
                inputMode="decimal"
                required
                value={entry.quantity}
                onChange={(e) => change(i, 'quantity', e.target.value)}
              />
            </label>
            <label>
              Condition {i + 1}
              <select
                aria-label={`Condition ${i + 1}`}
                value={entry.condition}
                onChange={(e) => change(i, 'condition', e.target.value)}
              >
                {conditions.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            {mode === 'discrepancy' && (
              <label>
                Resolution {i + 1}
                <select
                  aria-label={`Resolution ${i + 1}`}
                  value={entry.resolution}
                  onChange={(e) => change(i, 'resolution', e.target.value)}
                >
                  <option value="lost">Record loss</option>
                  <option value="return_to_source">Return to source</option>
                </select>
              </label>
            )}
          </div>
        );
      })}
      <button>
        {mode === 'receipt'
          ? 'Post actual receipt'
          : 'Request discrepancy review'}
      </button>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </form>
  );
}
