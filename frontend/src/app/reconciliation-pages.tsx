import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CorrectionInput } from '@jce/shared';
import { ApiError, useSession, useData, useAllowed } from './session';
import { Editor, Grid, LoadState, text, type Row } from './forms';
type ReturnInput = Extract<CorrectionInput, { kind: 'return' }>;
const methods = ['cash', 'card', 'ewallet'] as const;
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Request failed.';
export function Reconciliation() {
  const { session } = useSession();
  return (
    <ReconciliationBody key={`${session!.user.id}:${session!.branchId}`} />
  );
}
function ReconciliationBody() {
  const { session, write } = useSession();
  const base = `/branches/${session!.branchId}/reconciliation`;
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1),
    [shiftPage, setShiftPage] = useState(1);
  const requests = useData<{ rows: Row[]; hasMore: boolean }>(
    `${base}/requests?page=${page}`,
  );
  const shifts = useData<{ rows: Row[]; hasMore: boolean }>(
    `${base}/sessions?page=${shiftPage}`,
  );
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const storageKey = `jce:correction:${session!.user.id}:${session!.branchId}`;
  type Pending = { requestKey: string; input: CorrectionInput };
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(storageKey) ?? 'null',
      ) as Pending | null;
    } catch {
      return null;
    }
  });
  const submit = async (saved: Pending) => {
    setBusy(true);
    setError('');
    try {
      localStorage.setItem(storageKey, JSON.stringify(saved));
      setPending(saved);
      const result = await write<{ id: string }>(`${base}/requests`, saved);
      localStorage.removeItem(storageKey);
      setPending(null);
      setParams({ request: result.id });
    } catch (e) {
      if (
        e instanceof ApiError &&
        [400, 404, 409].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT'
      ) {
        localStorage.removeItem(storageKey);
        setPending(null);
      }
      setError(errorText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const create = (input: CorrectionInput) =>
    submit({ requestKey: crypto.randomUUID(), input });
  const canReturn = useAllowed('returns.use');
  return (
    <div className="inventory-page">
      <h1>Returns &amp; daily close</h1>
      <p>
        Refund original receipts, record cash movements, and reconcile each
        shift. A different manager reviews refunds, withdrawals and closing
        counts.
      </p>
      {error && <p role="alert">{error}</p>}
      {pending ? (
        <section className="record-form">
          <h2>Check saved request</h2>
          <p>
            The result is uncertain. Retry this saved request to recover it.
          </p>
          <button
            disabled={busy}
            onClick={() => void submit(pending).catch(() => {})}
          >
            Retry saved request
          </button>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Register shifts</h2>
            <LoadState query={shifts} />
            {shifts.data && (
              <>
                <Grid
                  title="Shifts"
                  rows={shifts.data.rows}
                  columns={[
                    ['register', 'Register'],
                    ['cashier', 'Cashier'],
                    ['business_date', 'Business date'],
                    ['status', 'Status'],
                  ]}
                  actions={(r) => (
                    <button onClick={() => setSessionId(text(r['id']))}>
                      Open shift
                    </button>
                  )}
                />
                <button
                  disabled={shiftPage === 1}
                  onClick={() => setShiftPage(shiftPage - 1)}
                >
                  Previous shifts
                </button>
                <button
                  disabled={!shifts.data.hasMore}
                  onClick={() => setShiftPage(shiftPage + 1)}
                >
                  Next shifts
                </button>
              </>
            )}
          </section>
          {sessionId && (
            <Shift key={sessionId} base={base} id={sessionId} create={create} />
          )}
          {canReturn && (
            <ReturnForm base={base} sessionId={sessionId} create={create} />
          )}
        </>
      )}
      <section className="card">
        <h2>Requests and posted corrections</h2>
        <LoadState query={requests} />
        {requests.data && (
          <>
            <Grid
              title="Correction requests"
              rows={requests.data.rows}
              columns={[
                ['kind', 'Action'],
                ['cashier', 'Cashier'],
                ['reason', 'Reason'],
                ['status', 'Status'],
              ]}
              actions={(r) => (
                <button onClick={() => setParams({ request: text(r['id']) })}>
                  Review request
                </button>
              )}
            />
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous requests
            </button>
            <button
              disabled={!requests.data.hasMore}
              onClick={() => setPage(page + 1)}
            >
              Next requests
            </button>
          </>
        )}
      </section>
      {params.get('request') && (
        <RequestDetail
          key={params.get('request')}
          base={base}
          id={params.get('request')!}
        />
      )}
    </div>
  );
}
function Shift({
  base,
  id,
  create,
}: {
  base: string;
  id: string;
  create: (d: CorrectionInput) => Promise<void>;
}) {
  const { session } = useSession();
  const data = useData<{
    summary: {
      session: Row;
      sales: Row;
      refunds: Row;
      tenders: Row[];
      movements: Row;
      expected: Record<string, string>;
      netSales: string;
      netPayments: string;
    };
    closure: Row | null;
    movements: Row[];
  }>(`${base}/sessions/${id}`);
  const canClose = useAllowed('register.close');
  if (!data.data) return <LoadState query={data} />;
  const { summary: s, closure } = data.data,
    own = s.session['actor_id'] === session!.user.id,
    open = s.session['status'] === 'open';
  return (
    <section className="card">
      <h2>Shift summary</h2>
      <p>
        Opening float: PHP {text(s.session['opening_float'])}. Status:{' '}
        {text(s.session['status'])}.
      </p>
      <Grid
        title="Tender reconciliation"
        rows={s.tenders.map((t) => ({
          ...t,
          expected: s.expected[text(t['method'])],
        }))}
        columns={[
          ['method', 'Tender'],
          ['tendered', 'Received'],
          ['sales', 'Applied after change'],
          ['refunds', 'Refunded'],
          ['expected', 'Expected at close'],
        ]}
      />
      <p>
        Change: PHP {text(s.sales['change'])}. Paid in:{' '}
        {text(s.movements['paid_in'])}; paid out:{' '}
        {text(s.movements['paid_out'])}; safe drops:{' '}
        {text(s.movements['safe_drop'])}.
      </p>
      <p>
        Sales less refunds: PHP {s.netSales}. Payments less refunds: PHP{' '}
        {s.netPayments}.
      </p>
      <Grid
        title="Cash movements"
        rows={data.data.movements}
        columns={[
          ['kind', 'Movement'],
          ['amount', 'Amount'],
          ['reason', 'Reason'],
        ]}
      />
      {closure && (
        <>
          <h3>Reviewed closing count</h3>
          <Grid
            title="Closing variances"
            rows={methods.map((m) => ({
              method: m,
              count: (closure['counts'] as Row)[m],
              variance: (closure['variance'] as Row)[m],
            }))}
            columns={[
              ['method', 'Tender'],
              ['count', 'Counted'],
              ['variance', 'Over / short'],
            ]}
          />
          <p>{text(closure['reason'])}</p>
        </>
      )}
      {own && open && (
        <>
          <Editor
            title="Cash movement"
            initial={{ movement: 'paid_in' }}
            fields={[
              {
                key: 'movement',
                label: 'Movement',
                type: 'select',
                options: ['paid_in', 'paid_out', 'safe_drop'].map((value) => ({
                  value,
                  label: value.replaceAll('_', ' '),
                })),
              },
              { key: 'amount', label: 'Cash amount' },
              { key: 'reason', label: 'Cash movement reason' },
            ]}
            submit="Prepare cash request"
            save={(d) =>
              create({
                kind: 'cash',
                sessionId: id,
                movement: d['movement'] as 'paid_in' | 'paid_out' | 'safe_drop',
                amount: text(d['amount']),
                reason: text(d['reason']),
              })
            }
          />
          {canClose && (
            <Editor
              title="Close this shift"
              initial={{ cash: '0', card: '0', ewallet: '0' }}
              fields={[
                ...methods.map((m) => ({ key: m, label: `Counted ${m}` })),
                { key: 'reason', label: 'Close notes / variance explanation' },
              ]}
              submit="Prepare closing count"
              save={(d) =>
                create({
                  kind: 'close',
                  sessionId: id,
                  counts: {
                    cash: text(d['cash']),
                    card: text(d['card']),
                    ewallet: text(d['ewallet']),
                  },
                  reason: text(d['reason']),
                })
              }
            />
          )}
        </>
      )}
      <p>
        Business dates use Manila midnight. Close each shift after posting or
        discarding its carts. Closed shifts stay locked; corrections use a new
        open shift.
      </p>
    </section>
  );
}
function ReturnForm({
  base,
  sessionId,
  create,
}: {
  base: string;
  sessionId: string;
  create: (d: CorrectionInput) => Promise<void>;
}) {
  const { session } = useSession();
  const [search, setSearch] = useState(''),
    [saleId, setSaleId] = useState('');
  const sales = useData<{ rows: Row[] }>(
    `/branches/${session!.branchId}/sales?q=${encodeURIComponent(search)}`,
  );
  return (
    <section className="card">
      <h2>Original-sale lookup</h2>
      <label>
        Receipt search
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
        />
      </label>
      <LoadState query={sales} />
      {sales.data && (
        <Grid
          title="Original sales"
          rows={sales.data.rows}
          columns={[
            ['number', 'Receipt'],
            ['total', 'Total'],
            ['customer', 'Customer'],
          ]}
          actions={(r) => (
            <button onClick={() => setSaleId(text(r['id']))}>
              Select for return
            </button>
          )}
        />
      )}
      {saleId && (
        <ReturnEditor
          key={`${saleId}:${sessionId}`}
          base={base}
          saleId={saleId}
          sessionId={sessionId}
          create={create}
        />
      )}
    </section>
  );
}
function ReturnEditor({
  base,
  saleId,
  sessionId,
  create,
}: {
  base: string;
  saleId: string;
  sessionId: string;
  create: (d: CorrectionInput) => Promise<void>;
}) {
  const source = useData<{ sale: Row; lines: Row[]; returns: Row[] }>(
    `${base}/sales/${saleId}`,
  );
  const [lines, setLines] = useState<
    Record<
      string,
      { quantity: string; condition: 'sellable' | 'damaged' | 'quarantined' }
    >
  >({});
  const [reversal, setReversal] = useState(false),
    [reason, setReason] = useState(''),
    [reasonCode, setReasonCode] =
      useState<ReturnInput['reasonCode']>('customer_return');
  const [amounts, setAmounts] = useState({
      cash: '0',
      card: '0',
      ewallet: '0',
    }),
    [refs, setRefs] = useState({ cash: '', card: '', ewallet: '' });
  const [preview, setPreview] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const { write } = useSession();
  if (!source.data) return <LoadState query={source} />;
  const input = (): ReturnInput => ({
    kind: 'return',
    sessionId,
    saleId,
    reversal,
    reasonCode,
    reason,
    lines: source.data!.lines.flatMap((l) => {
      const id = text(l['id']),
        value = lines[id] ?? { quantity: '0', condition: 'sellable' as const };
      return /[1-9]/.test(value.quantity) ? [{ saleItemId: id, ...value }] : [];
    }),
    payments: methods
      .filter((m) => /[1-9]/.test(amounts[m]))
      .map((method) => ({
        method,
        amount: amounts[method],
        reference: refs[method],
      })),
  });
  return (
    <form
      className="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void create(input())
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false));
      }}
    >
      <h3>Return {text(source.data.sale['number'])}</h3>
      {!sessionId && (
        <p role="alert">
          Open your register shift above before preparing a return.
        </p>
      )}
      <Link to={`/sales?sale=${saleId}`}>Original receipt</Link>
      <Grid
        title="Prior returns"
        rows={source.data.returns}
        columns={[
          ['number', 'Return'],
          ['total', 'Refund'],
          ['reversal', 'Full reversal'],
        ]}
      />
      <label>
        <input
          type="checkbox"
          checked={reversal}
          onChange={(e) => {
            setReversal(e.target.checked);
            setPreview(null);
            if (e.target.checked)
              setLines(
                Object.fromEntries(
                  source.data!.lines.map((l) => [
                    text(l['id']),
                    {
                      quantity: text(l['eligible']),
                      condition: 'sellable' as const,
                    },
                  ]),
                ),
              );
          }}
        />
        Full posted-sale reversal
      </label>
      {source.data.lines.map((l) => {
        const id = text(l['id']),
          value = lines[id] ?? {
            quantity: '0',
            condition: 'sellable' as const,
          };
        return (
          <fieldset key={id}>
            <legend>
              {text((l['snapshot'] as Row)['name'])} — eligible{' '}
              {text(l['eligible'])}
            </legend>
            <label>
              Return quantity
              <input
                value={value.quantity}
                onChange={(e) => {
                  setLines({
                    ...lines,
                    [id]: { ...value, quantity: e.target.value },
                  });
                  setPreview(null);
                }}
              />
            </label>
            <label>
              Stock disposition
              <select
                value={value.condition}
                onChange={(e) => {
                  setLines({
                    ...lines,
                    [id]: {
                      ...value,
                      condition: e.target.value as typeof value.condition,
                    },
                  });
                  setPreview(null);
                }}
              >
                {['sellable', 'damaged', 'quarantined'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </fieldset>
        );
      })}
      <label>
        Reason code
        <select
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value as typeof reasonCode)}
        >
          {['customer_return', 'damaged', 'sale_error'].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label>
        Return reason
        <input
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </label>
      <button
        type="button"
        disabled={busy || !sessionId}
        onClick={() => {
          setError('');
          setBusy(true);
          void write<Row>(`${base}/preview-return`, {
            ...input(),
            payments: [],
          })
            .then(setPreview)
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        Calculate refund
      </button>
      {preview && (
        <p role="status">
          Refund PHP {text(preview['total'])} (net {text(preview['net'])}, tax{' '}
          {text(preview['tax'])}). Enter the exact refund tender below.
        </p>
      )}
      {methods.map((m) => (
        <fieldset key={m}>
          <legend>{m} refund</legend>
          <label>
            Refund {m} amount
            <input
              value={amounts[m]}
              onChange={(e) => setAmounts({ ...amounts, [m]: e.target.value })}
            />
          </label>
          {m !== 'cash' && (
            <label>
              {m} refund reference
              <input
                value={refs[m]}
                onChange={(e) => setRefs({ ...refs, [m]: e.target.value })}
                maxLength={160}
              />
            </label>
          )}
        </fieldset>
      ))}
      <p>
        Noncash refunds are recorded manually. Use an original tender method and
        confirm the external refund before posting.
      </p>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || !sessionId || !preview}>
        Prepare return request
      </button>
    </form>
  );
}
function RequestDetail({ base, id }: { base: string; id: string }) {
  const { session, write } = useSession();
  const data = useData<{
    request: Row & { input: CorrectionInput; quote: Row };
    approvals: Row[];
    result: Row | null;
  }>(`${base}/requests/${id}`);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (!data.data) return <LoadState query={data} />;
  const r = data.data.request,
    d = r.input,
    own = r['actor_id'] === session!.user.id,
    posted = r['status'] === 'posted',
    q = r.quote;
  const canApprove = session!.permissions.includes(
    d.kind === 'return' ? 'returns.approve' : 'cash.approve',
  );
  return (
    <section className="record-form">
      <h2>Review {d.kind} request</h2>
      <p>
        Status: {text(r['status'])}. Reason: {d.reason}
      </p>
      {d.kind === 'return' && (
        <>
          <Link to={`/sales?sale=${d.saleId}`}>
            Original receipt {text(q['saleNumber'])}
          </Link>
          <p>
            {d.reversal ? 'Full reversal' : 'Return'} · Refund PHP{' '}
            {text(q['total'])}
          </p>
          <Grid
            title="Return allocations"
            rows={q['lines'] as Row[]}
            columns={[
              ['name', 'Product'],
              ['quantity', 'Quantity'],
              ['condition', 'Disposition'],
              ['discount', 'Original discount'],
              ['net', 'Net'],
              ['tax', 'Tax'],
              ['total', 'Refund'],
            ]}
          />
          <Grid
            title="Refund tenders"
            rows={d.payments}
            columns={[
              ['method', 'Method'],
              ['amount', 'Amount'],
              ['reference', 'Reference'],
            ]}
          />
        </>
      )}
      {d.kind === 'cash' && (
        <p>
          {d.movement.replaceAll('_', ' ')}: PHP {d.amount}
        </p>
      )}
      {d.kind === 'close' && (
        <Grid
          title="Close review"
          rows={methods.map((m) => ({
            method: m,
            expected: (q['expected'] as Row)[m],
            count: d.counts[m],
          }))}
          columns={[
            ['method', 'Tender'],
            ['expected', 'Expected'],
            ['count', 'Counted'],
          ]}
        />
      )}
      <Grid
        title="Manager approvals"
        rows={data.data.approvals}
        columns={[
          ['reviewer', 'Reviewer'],
          ['expires_at', 'Expires'],
        ]}
      />
      {!posted && !own && canApprove && (
        <Editor
          title="Manager authorization"
          fields={[
            {
              key: 'password',
              label: 'Confirm your password',
              type: 'password',
            },
          ]}
          submit="Approve exact request"
          save={(v) =>
            write(
              `${base}/requests/${id}/approve-${d.kind === 'return' ? 'return' : 'cash'}`,
              {
                requestKey: crypto.randomUUID(),
                password: text(v['password']),
              },
            )
          }
        />
      )}
      {!posted && own && (
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            void write(`${base}/requests/${id}/post`, { requestKey: id })
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          Post reviewed request
        </button>
      )}
      {posted && (
        <p role="status">
          Posted once.{' '}
          {data.data.result
            ? `Return receipt ${text(data.data.result['number'])}.`
            : ''}
        </p>
      )}
      {error && (
        <p role="alert">
          {error} Retry posting this same request if its result is uncertain.
        </p>
      )}
    </section>
  );
}
