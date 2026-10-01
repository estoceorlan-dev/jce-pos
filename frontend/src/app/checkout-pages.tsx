import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { CartInput, CheckoutInput, TenderInput } from '@jce/shared';
import { api, ApiError, useAllowed, useData, useSession } from './session';
import { Grid, LoadState, text, type Row } from './forms';
type Options = {
  variants: Row[];
  exact: string[];
  customers: Row[];
  registers: Row[];
  sessions: Row[];
  setupError: string;
};
type Quote = {
  lines: Row[];
  net: string;
  tax: string;
  total: string;
  discount: string;
  customer: string;
  settings: { tenders: TenderInput['method'][] };
};
type CartView = {
  cart: {
    id: string;
    actor_id: string;
    version: number;
    status: string;
    input: CartInput;
    quote: Quote;
  };
  approval: { reviewer: string; expires_at: string } | null;
  sale: { id: string; number: string } | null;
};
type Pending = { cartId: string; input: CheckoutInput };
function centavos(value: string) {
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function cashPreview(total: string, payments: TenderInput[]) {
  const due = centavos(total)!;
  let handed = 0n,
    noncash = 0n;
  for (const p of payments) {
    const amount = centavos(p.amount);
    if (amount === null) return 'Enter valid payment amounts.';
    handed += amount;
    if (p.method !== 'cash') noncash += amount;
  }
  if (noncash > due) return 'Noncash payments exceed the total.';
  const difference = handed - due,
    absolute = difference < 0n ? -difference : difference;
  const value = `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  return difference < 0n
    ? `Still due PHP ${value}`
    : `Expected change PHP ${value}`;
}
function readPending(key: string): Pending | null {
  const value = localStorage.getItem(key);
  return value ? (JSON.parse(value) as Pending) : null;
}
function Pager({
  page,
  setPage,
  more,
}: {
  page: number;
  setPage: (p: number) => void;
  more: boolean;
}) {
  return (
    <div className="actions">
      <button disabled={page === 1} onClick={() => setPage(page - 1)}>
        Previous
      </button>
      <span>Page {page}</span>
      <button disabled={!more} onClick={() => setPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
export function Checkout() {
  const { session, write } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const base = `/branches/${session!.branchId}/checkout`;
  const storageKey = `checkout-pending:${session!.user.id}:${session!.branchId}`;
  const [pending, setPending] = useState<Pending | null>(() =>
    readPending(storageKey),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const options = useData<Options>(`${base}/options`);
  const carts = useData<{ rows: Row[]; hasMore: boolean }>(
    `${base}/carts?page=${page}`,
  );
  const [register, setRegister] = useState('');
  const [float, setFloat] = useState('0.00');
  const [openKey, setOpenKey] = useState(() => crypto.randomUUID());
  const [sessionId, setSessionId] = useState('');
  const selectedSession = sessionId || text(options.data?.sessions[0]?.['id']);
  const id = params.get('cart');
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const complete = (sale: { id: string }) => {
    localStorage.removeItem(storageKey);
    setPending(null);
    navigate(`/sales?sale=${sale.id}`);
  };
  const send = async (request: Pending) => {
    try {
      complete(
        await write<{ id: string }>(
          `${base}/carts/${request.cartId}/post`,
          request.input,
        ),
      );
    } catch (e) {
      // A definite rejection rolled back. Transport/5xx errors keep the exact request.
      if (
        e instanceof ApiError &&
        [400, 404, 409, 422].includes(e.status) &&
        e.code !== 'IDEMPOTENCY_CONFLICT'
      ) {
        localStorage.removeItem(storageKey);
        setPending(null);
      }
      throw e;
    }
  };
  return (
    <div className="checkout-page inventory-page">
      <h1>Checkout</h1>
      <p>
        Scan a barcode, review the saved cart, then record the payment. Held
        carts do not reserve stock.
      </p>
      {error && <p role="alert">{error}</p>}
      {pending ? (
        <section className="record-form">
          <h2>Checkout result needs checking</h2>
          <p>
            This request is saved on this workstation. Recover it before
            starting another sale here.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api<{ sale: { id: string } | null }>(
                    `${base}/requests/${pending.input.requestKey}`,
                  );
                  if (r.sale) complete(r.sale);
                  else
                    setError(
                      'No committed sale found yet. Retry the saved request; it may still be in progress.',
                    );
                })
              }
            >
              Check saved checkout
            </button>
            <button
              disabled={busy}
              onClick={() => void run(() => send(pending))}
            >
              Retry saved checkout
            </button>
          </div>
        </section>
      ) : (
        <>
          <LoadState query={options} />
          {options.data?.setupError && (
            <p role="alert">{options.data.setupError}</p>
          )}
          <section className="record-form">
            <h2>Register session</h2>
            <label>
              Open register session
              <select
                value={selectedSession}
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">Select session</option>
                {options.data?.sessions.map((s) => (
                  <option key={text(s['id'])} value={text(s['id'])}>
                    {text(s['register'])} · {text(s['terminal'])} · expected
                    cash PHP {text(s['expected_cash'])}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>Open a register with float</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const r = await write<{ id: string }>(`${base}/sessions`, {
                      requestKey: openKey,
                      registerId: register,
                      openingFloat: float,
                    });
                    setSessionId(r.id);
                    setOpenKey(crypto.randomUUID());
                  });
                }}
              >
                <div className="form-grid">
                  <label>
                    Register
                    <select
                      required
                      value={register}
                      onChange={(e) => setRegister(e.target.value)}
                    >
                      <option value="">Select register</option>
                      {options.data?.registers.map((r) => (
                        <option key={text(r['id'])} value={text(r['id'])}>
                          {text(r['code'])} · {text(r['terminal'])}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Opening float (PHP)
                    <input
                      required
                      inputMode="decimal"
                      value={float}
                      onChange={(e) => setFloat(e.target.value)}
                    />
                  </label>
                </div>
                <button disabled={busy || !register}>Open register</button>
              </form>
            </details>
          </section>
          <div className="actions">
            <button
              disabled={!selectedSession || !!options.data?.setupError}
              onClick={() => setParams({ new: crypto.randomUUID() })}
            >
              New cart
            </button>
            <Link to="/sales">Transactions & receipts</Link>
          </div>
          {params.get('new') && selectedSession && (
            <CartEditor
              key={params.get('new')}
              base={base}
              sessionId={selectedSession}
              done={(id) => setParams({ cart: id })}
            />
          )}
          {id && (
            <CartDetail
              key={id}
              base={base}
              id={id}
              onPost={async (cartId, input) => {
                const previous = readPending(storageKey);
                if (previous) {
                  setPending(previous);
                  return;
                }
                const request = { cartId, input };
                localStorage.setItem(storageKey, JSON.stringify(request));
                setPending(request);
                await run(() => send(request));
              }}
            />
          )}
          <section>
            <h2>Active and held carts</h2>
            <LoadState query={carts} />
            {carts.data && (
              <>
                <Grid
                  title="Saved carts"
                  rows={carts.data.rows}
                  columns={[
                    ['cashier', 'Cashier'],
                    ['status', 'Status'],
                    ['customer', 'Customer'],
                    ['total', 'Total (PHP)'],
                    ['discount', 'Discount (PHP)'],
                  ]}
                  actions={(r) => (
                    <button onClick={() => setParams({ cart: text(r['id']) })}>
                      Open cart
                    </button>
                  )}
                />
                <Pager
                  page={page}
                  setPage={setPage}
                  more={carts.data.hasMore}
                />
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
function CartEditor({
  base,
  sessionId,
  initial,
  done,
}: {
  base: string;
  sessionId: string;
  initial?: CartView;
  done: (id: string) => void;
}) {
  const { write } = useSession();
  const scan = useRef<HTMLInputElement>(null);
  useEffect(() => {
    scan.current?.focus();
  }, []);
  const [q, setQ] = useState(''),
    [customerQ, setCustomerQ] = useState('');
  const options = useData<Options>(
    `${base}/options?q=${encodeURIComponent(q)}&customerQ=${encodeURIComponent(customerQ)}`,
  );
  const [customerId, setCustomerId] = useState(
    initial?.cart.input.customerId ?? '',
  );
  type Line = CartInput['lines'][number] & { name: string };
  const [lines, setLines] = useState<Line[]>(
    initial?.cart.input.lines.map((l) => ({
      ...l,
      name: text(
        initial.cart.quote.lines.find((v) => v['id'] === l.variantId)?.['sku'],
      ),
    })) ?? [],
  );
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const add = (v: Row) => {
    setError('');
    const id = text(v['id']);
    setLines((old) => {
      const existing = old.find((l) => l.variantId === id);
      if (!existing)
        return [
          ...old,
          {
            variantId: id,
            quantity: '1',
            discount: '0.00',
            name: text(v['sku']),
          },
        ];
      if (!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(existing.quantity)) {
        setError('Correct the quantity before scanning this item again.');
        return old;
      }
      const [whole, fraction = ''] = existing.quantity.split('.');
      const scaled =
        BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0')) + 1000000n;
      const quantity = `${scaled / 1000000n}.${(scaled % 1000000n).toString().padStart(6, '0')}`;
      return old.map((l) => (l.variantId === id ? { ...l, quantity } : l));
    });
    setQ('');
    scan.current?.focus();
  };
  const scanItem = async () => {
    try {
      const o = await api<Options>(
        `${base}/options?q=${encodeURIComponent(q)}`,
      );
      const exact = o.variants.filter((v) => o.exact.includes(text(v['id'])));
      const found =
        exact.length === 1
          ? exact[0]
          : o.variants.length === 1
            ? o.variants[0]
            : null;
      if (found) add(found);
      else setError('Choose a matching product from the results.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form
      className="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const cart = {
          sessionId,
          customerId: customerId || null,
          lines: lines.map(({ name: _name, ...l }) => l),
        };
        void write<{ id: string }>(
          `${base}/carts${initial ? '/' + initial.cart.id : ''}`,
          initial
            ? { version: initial.cart.version, cart }
            : { requestKey: key, cart },
          initial ? 'PUT' : 'POST',
        )
          .then((r) => done(r.id))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{initial ? 'Edit cart' : 'New cart'}</h2>
      <label>
        Scan barcode or search
        <input
          ref={scan}
          value={q}
          maxLength={100}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void scanItem();
            }
          }}
        />
      </label>
      <button
        type="button"
        disabled={!q || busy}
        onClick={() => void scanItem()}
      >
        Add scanned item
      </button>
      <LoadState query={options} />
      {q && (
        <div className="scan-results" aria-label="Product matches">
          {options.data?.variants.map((v) => (
            <button type="button" key={text(v['id'])} onClick={() => add(v)}>
              {text(v['sku'])} · {text(v['name'])} · PHP {text(v['price'])}
            </button>
          ))}
        </div>
      )}
      <div className="form-grid">
        <label>
          Find customer
          <input
            value={customerQ}
            maxLength={100}
            onChange={(e) => setCustomerQ(e.target.value)}
          />
        </label>
        <label>
          Customer
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">Walk-in customer</option>
            {customerId &&
              !options.data?.customers.some((c) => c['id'] === customerId) && (
                <option value={customerId}>
                  {initial?.cart.quote.customer ?? 'Selected customer'}
                </option>
              )}
            {options.data?.customers.map((c) => (
              <option key={text(c['id'])} value={text(c['id'])}>
                {text(c['name'])}
              </option>
            ))}
          </select>
        </label>
      </div>
      {lines.map((l, i) => (
        <fieldset key={l.variantId}>
          <legend>{l.name}</legend>
          <div className="form-grid">
            <label>
              Quantity for {l.name}
              <input
                required
                inputMode="decimal"
                value={l.quantity}
                onChange={(e) =>
                  setLines(
                    lines.map((v, n) =>
                      n === i ? { ...v, quantity: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
            <label>
              Line discount for {l.name} (PHP)
              <input
                required
                inputMode="decimal"
                value={l.discount}
                onChange={(e) =>
                  setLines(
                    lines.map((v, n) =>
                      n === i ? { ...v, discount: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => setLines(lines.filter((_, n) => n !== i))}
          >
            Remove {l.name}
          </button>
        </fieldset>
      ))}
      <p>
        Save to calculate current prices, discounts and taxes. Every manual
        discount needs a different reviewer; editing invalidates approval.
      </p>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || lines.length === 0}>
        Save and review cart
      </button>
    </form>
  );
}
function CartDetail({
  base,
  id,
  onPost,
}: {
  base: string;
  id: string;
  onPost: (id: string, input: CheckoutInput) => Promise<void>;
}) {
  const query = useData<CartView>(`${base}/carts/${id}`);
  return (
    <>
      <LoadState query={query} />
      {query.data && (
        <CartReview
          key={`${id}:${query.data.cart.version}`}
          base={base}
          data={query.data}
          onPost={onPost}
        />
      )}
    </>
  );
}
function CartReview({
  base,
  data,
  onPost,
}: {
  base: string;
  data: CartView;
  onPost: (id: string, input: CheckoutInput) => Promise<void>;
}) {
  const { session, write, refresh } = useSession();
  const approve = useAllowed('checkout.approve');
  const { cart, approval, sale } = data;
  const owner = cart.actor_id === session!.user.id;
  const [edit, setEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [password, setPassword] = useState(''),
    [reason, setReason] = useState('');
  const [payments, setPayments] = useState<TenderInput[]>([
    {
      method: cart.quote.settings.tenders[0]!,
      amount: cart.quote.total,
      reference: '',
    },
  ]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPassword('');
    }
  };
  const action = (name: string) =>
    run(() =>
      write(`${base}/carts/${cart.id}/${name}`, {
        version: cart.version,
        requestKey: crypto.randomUUID(),
      }),
    );
  if (edit)
    return (
      <CartEditor
        base={base}
        sessionId={cart.input.sessionId}
        initial={data}
        done={() => setEdit(false)}
      />
    );
  return (
    <section className="record-form">
      <h2>Review cart</h2>
      <p>
        Status: {cart.status} · Customer: {cart.quote.customer}
      </p>
      <Grid
        title="Cart lines"
        rows={cart.quote.lines}
        columns={[
          ['sku', 'SKU'],
          ['name', 'Product'],
          ['quantity', 'Quantity'],
          ['price', 'Price (PHP)'],
          ['discount', 'Discount'],
          ['tax_code', 'Tax code'],
          ['tax', 'Tax'],
          ['total', 'Total'],
        ]}
      />
      <p className="checkout-total">
        Net PHP {cart.quote.net} · discount PHP {cart.quote.discount} · tax PHP{' '}
        {cart.quote.tax} · total PHP {cart.quote.total}
      </p>
      {sale && (
        <Link to={`/sales?sale=${sale.id}`}>
          Open committed receipt {sale.number}
        </Link>
      )}
      {error && <p role="alert">{error}</p>}
      {['active', 'held'].includes(cart.status) && (
        <>
          <div className="actions">
            <button disabled={busy} onClick={() => void refresh()}>
              Refresh review
            </button>
            {owner && (
              <>
                {cart.status === 'active' ? (
                  <>
                    <button disabled={busy} onClick={() => setEdit(true)}>
                      Edit cart
                    </button>
                    <button disabled={busy} onClick={() => void action('hold')}>
                      Hold cart
                    </button>
                  </>
                ) : (
                  <button disabled={busy} onClick={() => void action('resume')}>
                    Resume cart
                  </button>
                )}
                <button disabled={busy} onClick={() => void action('cancel')}>
                  Cancel draft cart
                </button>
              </>
            )}
          </div>
          {cart.quote.discount !== '0.00' && (
            <>
              <p>
                {approval
                  ? `Discount reviewed by ${approval.reviewer}; valid until ${new Date(approval.expires_at).toLocaleTimeString()}.`
                  : 'A different authorized reviewer must approve this discount.'}
              </p>
              {approve && !owner && cart.status === 'active' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() =>
                      write(`${base}/carts/${cart.id}/approve-discount`, {
                        version: cart.version,
                        requestKey: crypto.randomUUID(),
                        password,
                        reason,
                      }),
                    );
                  }}
                >
                  <label>
                    Discount review reason
                    <input
                      required
                      maxLength={500}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <label>
                    Reviewer password
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  <button disabled={busy}>Approve exact discount</button>
                </form>
              )}
            </>
          )}
          {owner && cart.status === 'active' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  onPost(cart.id, {
                    version: cart.version,
                    requestKey: crypto.randomUUID(),
                    payments,
                  }),
                );
              }}
            >
              <h3>Payments</h3>
              <p>
                Record card/e-wallet only after checking payment separately.
                References are required. Change is given only from cash.
              </p>
              {payments.map((p, i) => (
                <fieldset key={i}>
                  <legend>Payment {i + 1}</legend>
                  <div className="form-grid">
                    <label>
                      Method {i + 1}
                      <select
                        value={p.method}
                        onChange={(e) =>
                          setPayments(
                            payments.map((v, n) =>
                              n === i
                                ? {
                                    ...v,
                                    method: e.target
                                      .value as TenderInput['method'],
                                  }
                                : v,
                            ),
                          )
                        }
                      >
                        {cart.quote.settings.tenders.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Amount {i + 1} (PHP)
                      <input
                        required
                        inputMode="decimal"
                        value={p.amount}
                        onChange={(e) =>
                          setPayments(
                            payments.map((v, n) =>
                              n === i ? { ...v, amount: e.target.value } : v,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      Reference {i + 1}
                      <input
                        maxLength={160}
                        required={p.method !== 'cash'}
                        value={p.reference}
                        onChange={(e) =>
                          setPayments(
                            payments.map((v, n) =>
                              n === i ? { ...v, reference: e.target.value } : v,
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                  {payments.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setPayments(payments.filter((_, n) => n !== i))
                      }
                    >
                      Remove payment {i + 1}
                    </button>
                  )}
                </fieldset>
              ))}
              <div className="actions">
                <button
                  type="button"
                  disabled={
                    payments.length >= cart.quote.settings.tenders.length
                  }
                  onClick={() =>
                    setPayments([
                      ...payments,
                      {
                        method:
                          cart.quote.settings.tenders.find(
                            (t) => !payments.some((p) => p.method === t),
                          ) ?? 'cash',
                        amount: '0.00',
                        reference: '',
                      },
                    ])
                  }
                >
                  Add split payment
                </button>
                <button disabled={busy}>Complete sale</button>
              </div>
              <p role="status">{cashPreview(cart.quote.total, payments)}</p>
            </form>
          )}
        </>
      )}
    </section>
  );
}
export function Sales() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(''),
    [page, setPage] = useState(1),
    [unprinted, setUnprinted] = useState(false);
  const base = `/branches/${session!.branchId}/sales`;
  const query = useData<{ rows: Row[]; hasMore: boolean }>(
    `${base}?page=${page}&q=${encodeURIComponent(q)}&unprinted=${unprinted}`,
  );
  const id = params.get('sale');
  return (
    <div className="sales-page inventory-page">
      <div className="no-print">
        <h1>Transactions & receipts</h1>
        <div className="toolbar">
          <label>
            Find receipt or customer
            <input
              value={q}
              maxLength={100}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={unprinted}
              onChange={(e) => {
                setUnprinted(e.target.checked);
                setPage(1);
              }}
            />{' '}
            Printing not confirmed
          </label>
        </div>
        <LoadState query={query} />
        {query.data && (
          <>
            <Grid
              title="Posted sales"
              rows={query.data.rows}
              columns={[
                ['number', 'Receipt'],
                ['customer', 'Customer'],
                ['cashier', 'Cashier'],
                ['total', 'Total (PHP)'],
                ['posted_at', 'Posted'],
                ['print_confirmed', 'Printing confirmed'],
              ]}
              actions={(r) => (
                <button onClick={() => setParams({ sale: text(r['id']) })}>
                  Open receipt
                </button>
              )}
            />
            <Pager page={page} setPage={setPage} more={query.data.hasMore} />
          </>
        )}
      </div>
      {id && <SaleReceipt key={id} base={base} id={id} />}
    </div>
  );
}
function SaleReceipt({ base, id }: { base: string; id: string }) {
  const { session, write } = useSession();
  const query = useData<{
    sale: Row;
    lines: Row[];
    payments: Row[];
    prints: Row[];
    returns: Row[];
  }>(`${base}/${id}`);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!query.data) return <LoadState query={query} />;
  const { sale, lines, payments, prints } = query.data,
    snap = sale['snapshot'] as Row,
    business = snap['business'] as Row,
    branch = snap['branch'] as Row;
  const pending = prints
    .filter(
      (p) =>
        p['outcome'] === 'requested' &&
        !prints.some((r) => r['attempt_id'] === p['id']) &&
        p['actor_id'] === session!.user.id,
    )
    .at(-1);
  const confirmed = prints.some((p) => p['outcome'] === 'confirmed');
  return (
    <section className={`sale-receipt paper-${text(snap['paperWidth'])}`}>
      <h2>Receipt {text(sale['number'])}</h2>
      <p>
        {text(business['name'])}
        <br />
        {text(business['address'])}
        <br />
        {text(branch['name'])} · {text(branch['code'])}
      </p>
      <p>
        {new Date(text(sale['posted_at'])).toLocaleString('en-PH', {
          timeZone: 'Asia/Manila',
        })}{' '}
        · Asia/Manila
        <br />
        Cashier: {text(snap['cashier'])} · Register: {text(snap['register'])}
        <br />
        Customer: {text(snap['customer'])}
      </p>
      {lines.map((l) => {
        const s = l['snapshot'] as Row;
        return (
          <article className="receipt-line" key={text(l['id'])}>
            <strong>{text(s['name'])}</strong>
            <p>
              {text(s['sku'])} · {text(l['quantity'])} × PHP {text(l['price'])}
            </p>
            <p>
              Discount {text(l['discount'])} · {text(s['tax_code'])} · tax{' '}
              {text(l['tax'])}
            </p>
            <b>PHP {text(l['total'])}</b>
          </article>
        );
      })}
      <p>
        Net PHP {text(sale['net'])}
        <br />
        Discount PHP {text(sale['discount'])}
        <br />
        Tax PHP {text(sale['tax'])}
      </p>
      <strong className="receipt-total">Total PHP {text(sale['total'])}</strong>
      {payments.map((p) => (
        <p key={text(p['method'])}>
          {text(p['method'])}: PHP {text(p['amount'])}
          {p['reference'] ? ` · ${text(p['reference'])}` : ''}
        </p>
      ))}
      <p>Change PHP {text(sale['change'])}</p>
      <p>{text(business['receiptFooter'])}</p>
      <div className="no-print">
        <p role="status">
          {confirmed
            ? 'Printing confirmed by operator.'
            : 'Sale committed — printing not confirmed.'}
        </p>
        {error && <p role="alert">{error}</p>}
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await write(`${base}/${id}/print`, {
                requestKey: crypto.randomUUID(),
                outcome: 'requested',
                attemptId: null,
              });
              window.print();
            })
          }
        >
          {prints.some((p) => p['outcome'] === 'requested')
            ? 'Reprint receipt'
            : 'Print receipt'}
        </button>
        {pending && (
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await write(`${base}/${id}/print`, {
                    requestKey: crypto.randomUUID(),
                    outcome: 'confirmed',
                    attemptId: pending['id'],
                  });
                })
              }
            >
              Confirm paper printed
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await write(`${base}/${id}/print`, {
                    requestKey: crypto.randomUUID(),
                    outcome: 'failed',
                    attemptId: pending['id'],
                  });
                })
              }
            >
              Record printing failed
            </button>
          </div>
        )}
        <Grid
          title="Print and reprint history"
          rows={prints}
          columns={[
            ['outcome', 'Outcome'],
            ['actor', 'Operator'],
            ['occurred_at', 'Time'],
          ]}
        />
        <Grid
          title="Linked returns and reversals"
          rows={query.data.returns}
          columns={[
            ['number', 'Return receipt'],
            ['total', 'Refund'],
            ['reversal', 'Full reversal'],
          ]}
          actions={(r) => (
            <Link to={`/reconciliation?request=${text(r['id'])}`}>
              Open correction
            </Link>
          )}
        />
      </div>
    </section>
  );
}
