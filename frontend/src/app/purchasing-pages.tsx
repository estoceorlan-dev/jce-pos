import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { PurchaseOrderInput, PurchaseReceiptInput } from '@jce/shared';
import { useAllowed, useData, useSession } from './session';
import { Grid, LoadState, text, type Row } from './forms';
type List = { rows: Row[]; hasMore: boolean; totals?: Row };
type OrderData = { order: Row; lines: Row[]; events: Row[] };
type ReceiptData = {
  receipt: Row;
  items: Row[];
  receiver: string;
  approver: string | null;
};
function key(scope: string) {
  const name = `purchase:${scope}`;
  const previous = sessionStorage.getItem(name);
  if (previous) return previous;
  const id = crypto.randomUUID();
  sessionStorage.setItem(name, id);
  return id;
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
export function Purchasing() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(
    params.get('supplier') || params.get('historyOrder')
      ? 'receipts'
      : 'orders',
  );
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState(false);
  const base = `/branches/${session!.branchId}/purchasing`;
  const supplier = params.get('supplier');
  const order = params.get('order');
  const receipt = params.get('receipt');
  const historyOrder = params.get('historyOrder');
  const manage = useAllowed('purchasing.manage');
  const query = useData<List>(
    `${base}/${tab}?page=${page}${tab === 'orders' ? `&status=${status}&q=${encodeURIComponent(q)}` : ''}${supplier ? `&supplierId=${supplier}` : ''}${tab === 'receipts' && historyOrder ? `&orderId=${historyOrder}` : ''}`,
  );
  const open = (kind: 'order' | 'receipt', id: string) => {
    setParams({
      ...Object.fromEntries(params),
      [kind]: id,
      [kind === 'order' ? 'receipt' : 'order']: '',
    });
    setEditor(false);
  };
  return (
    <div className="purchase-page inventory-page">
      <h1>Purchasing & receiving</h1>
      <p>
        Approved orders authorize quantities and costs. Stock changes only when
        a goods receipt posts.
      </p>
      <div className="actions no-print">
        {historyOrder && (
          <button onClick={() => setParams({})}>
            Clear order history filter
          </button>
        )}
        <button
          onClick={() => {
            setTab('orders');
            setPage(1);
          }}
        >
          Purchase orders
        </button>
        <button
          onClick={() => {
            setTab('receipts');
            setPage(1);
          }}
        >
          Receiving history
        </button>
        {manage && (
          <button
            onClick={() => {
              setEditor(true);
              setParams(supplier ? { supplier } : {});
            }}
          >
            New purchase order
          </button>
        )}
        {supplier && (
          <button onClick={() => setParams({})}>Clear supplier filter</button>
        )}
      </div>
      <section className="no-print">
        {tab === 'orders' && (
          <div className="toolbar">
            <label>
              Search orders
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                maxLength={100}
              />
            </label>
            <label>
              Order status
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                {[
                  'all',
                  'outstanding',
                  'draft',
                  'submitted',
                  'approved',
                  'partially_received',
                  'received',
                  'closed',
                  'cancelled',
                  'rejected',
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <LoadState query={query} />
        {query.data && (
          <>
            <Grid
              title={
                tab === 'orders'
                  ? 'Purchase orders'
                  : 'Goods receipts and reversals'
              }
              rows={query.data.rows}
              columns={
                tab === 'orders'
                  ? [
                      ['number', 'Order'],
                      ['supplier', 'Supplier'],
                      ['status', 'Status'],
                      ['note', 'Notes'],
                    ]
                  : [
                      ['number', 'Receipt'],
                      ['supplier', 'Supplier'],
                      ['kind', 'Kind'],
                      ['status', 'Status'],
                      ['supplier_reference', 'Invoice reference'],
                      ['delivery_reference', 'Delivery reference'],
                      ['total', 'Supplier total (PHP)'],
                    ]
              }
              actions={(r) => (
                <button
                  onClick={() =>
                    open(tab === 'orders' ? 'order' : 'receipt', text(r['id']))
                  }
                >
                  Open {tab === 'orders' ? 'order' : 'receipt'}
                </button>
              )}
            />
            <Pager page={page} setPage={setPage} more={query.data.hasMore} />
            {query.data.totals && (
              <p>
                Posted supplier totals, net of reversals: net PHP{' '}
                {text(query.data.totals['net'])} · tax PHP{' '}
                {text(query.data.totals['tax'])} · total PHP{' '}
                {text(query.data.totals['total'])} · inventory value PHP{' '}
                {text(query.data.totals['stock_value'])}
              </p>
            )}
          </>
        )}
      </section>
      {editor && (
        <OrderEditor
          base={base}
          initialSupplier={supplier ?? ''}
          done={(id) => open('order', id)}
        />
      )}
      {order && (
        <OrderDetail
          key={order}
          base={base}
          id={order}
          openReceipt={(id) => open('receipt', id)}
          showHistory={() => {
            setTab('receipts');
            setPage(1);
            setParams({ historyOrder: order });
          }}
        />
      )}
      {receipt && (
        <ReceiptDetail
          key={receipt}
          base={base}
          id={receipt}
          open={(id) => open('receipt', id)}
        />
      )}
    </div>
  );
}
function OrderEditor({
  base,
  initialSupplier = '',
  initial,
  done,
}: {
  base: string;
  initialSupplier?: string;
  initial?: OrderData;
  done: (id: string) => void;
}) {
  const { write } = useSession();
  const [q, setQ] = useState('');
  const [supplierQ, setSupplierQ] = useState('');
  const options = useData<{ suppliers: Row[]; variants: Row[] }>(
    `${base}/options?q=${encodeURIComponent(q)}&supplierQ=${encodeURIComponent(supplierQ)}`,
  );
  const [supplierId, setSupplier] = useState(
    text(initial?.order['supplier_id']) || initialSupplier,
  );
  const [note, setNote] = useState(text(initial?.order['note']));
  type Line = PurchaseOrderInput['lines'][number] & {
    sku: string;
    conversion: string;
  };
  const [lines, setLines] = useState<Line[]>(
    initial?.lines.map((l) => ({
      variantId: text(l['variant_id']),
      sku: text((l['snapshot'] as Row)['sku']),
      conversion: text(l['conversion']),
      quantity: text(l['quantity']),
      unitCost: text(l['unit_cost']),
      discountRate: text(l['discount_rate']),
      taxRate: text(l['tax_rate']),
      taxInclusive: Boolean(l['tax_inclusive']),
      capitalizeTax: Boolean(l['capitalize_tax']),
    })) ?? [],
  );
  const [selected, setSelected] = useState('');
  const [requestKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (index: number, patch: Partial<Line>) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  return (
    <form
      className="record-form no-print"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const order = {
          supplierId,
          note,
          lines: lines.map(({ sku: _sku, conversion: _conversion, ...l }) => l),
        };
        void write<{ id: string }>(
          `${base}/orders${initial ? '/' + text(initial.order['id']) : ''}`,
          initial
            ? { version: initial.order['version'], order }
            : { requestKey, order },
          initial ? 'PUT' : 'POST',
        )
          .then((r) => done(r.id))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{initial ? 'Edit purchase order' : 'New purchase order'}</h2>
      <LoadState query={options} />
      <div className="form-grid">
        <label>
          Find supplier
          <input
            value={supplierQ}
            maxLength={100}
            onChange={(e) => setSupplierQ(e.target.value)}
          />
        </label>
        <label>
          Supplier
          <select
            required
            value={supplierId}
            onChange={(e) => setSupplier(e.target.value)}
          >
            <option value="">Select supplier</option>
            {options.data?.suppliers.map((s) => (
              <option key={text(s['id'])} value={text(s['id'])}>
                {text(s['name'])}
              </option>
            ))}
          </select>
        </label>
        <label>
          Order notes
          <input
            required
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label>
          Find product
          <input
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          Product variant
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select variant</option>
            {options.data?.variants.map((v) => (
              <option key={text(v['id'])} value={text(v['id'])}>
                {text(v['sku'])} · {text(v['name'])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={!selected || lines.some((l) => l.variantId === selected)}
        onClick={() => {
          const v = options.data!.variants.find((v) => v['id'] === selected)!;
          setLines([
            ...lines,
            {
              variantId: selected,
              sku: text(v['sku']),
              conversion: text(v['conversion']),
              quantity: '1',
              unitCost: '0',
              discountRate: '0',
              taxRate: '0',
              taxInclusive: false,
              capitalizeTax: false,
            },
          ]);
        }}
      >
        Add order line
      </button>
      {lines.map((l, i) => (
        <fieldset key={l.variantId}>
          <legend>
            {l.sku} · {l.conversion} base units per purchase unit
          </legend>
          <div className="form-grid">
            <label>
              Ordered quantity
              <input
                required
                value={l.quantity}
                onChange={(e) => update(i, { quantity: e.target.value })}
              />
            </label>
            <label>
              Cost per purchase unit (PHP)
              <input
                required
                value={l.unitCost}
                onChange={(e) => update(i, { unitCost: e.target.value })}
              />
            </label>
            <label>
              Discount rate (0.10 = 10%)
              <input
                required
                value={l.discountRate}
                onChange={(e) => update(i, { discountRate: e.target.value })}
              />
            </label>
            <label>
              Tax rate (0.12 = 12%)
              <input
                required
                value={l.taxRate}
                onChange={(e) => update(i, { taxRate: e.target.value })}
              />
            </label>
            <label>
              Cost includes tax
              <select
                value={String(l.taxInclusive)}
                onChange={(e) =>
                  update(i, { taxInclusive: e.target.value === 'true' })
                }
              >
                <option value="false">No — add tax</option>
                <option value="true">Yes — tax included</option>
              </select>
            </label>
            <label>
              Inventory valuation tax treatment
              <select
                value={String(l.capitalizeTax)}
                onChange={(e) =>
                  update(i, { capitalizeTax: e.target.value === 'true' })
                }
              >
                <option value="false">Exclude tax from inventory cost</option>
                <option value="true">Include tax in inventory cost</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={() => setLines(lines.filter((_, n) => n !== i))}
          >
            Remove line
          </button>
        </fieldset>
      ))}
      <p>
        Confirm invoice tax treatment with your reviewer. No freight allocation
        is applied.
      </p>
      <button disabled={busy || !lines.length}>Save order draft</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function OrderDetail({
  base,
  id,
  openReceipt,
  showHistory,
}: {
  base: string;
  id: string;
  openReceipt: (id: string) => void;
  showHistory: () => void;
}) {
  const { session, write } = useSession();
  const manage = useAllowed('purchasing.manage');
  const approve = useAllowed('purchasing.approve');
  const receive = useAllowed('purchasing.receive');
  const query = useData<OrderData>(`${base}/orders/${id}`);
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = (action: string) => {
    setBusy(true);
    setError('');
    const version = query.data!.order['version'];
    void write(`${base}/orders/${id}/${action}`, {
      version,
      requestKey: key(`${session!.user.id}:${id}:${version}:${action}`),
      reason,
      ...(['approve', 'reject', 'close'].includes(action) ? { password } : {}),
    })
      .then(() => setPassword(''))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  if (!query.data) return <LoadState query={query} />;
  const { order, lines, events } = query.data;
  const status = text(order['status']);
  const author = order['actor_id'] === session!.user.id;
  return (
    <section className="card history no-print">
      <h2>Purchase order {text(order['number'])}</h2>
      <button onClick={showHistory}>Receiving history for this order</button>
      <p>
        Status: <strong>{status}</strong> · Version {text(order['version'])}
      </p>
      <p>
        Supplier: {text((order['snapshot'] as Row)['supplierName'])} ·{' '}
        {text(order['note'])}
      </p>
      <Grid
        title="Ordered and received quantities"
        rows={lines.map((l) => ({ ...l, sku: (l['snapshot'] as Row)['sku'] }))}
        columns={[
          ['sku', 'SKU'],
          ['quantity', 'Ordered units'],
          ['received', 'Received units'],
          ['outstanding', 'Unreceived units'],
          ['conversion', 'Base conversion'],
          ['unit_cost', 'Unit cost'],
          ['discount_rate', 'Discount rate'],
          ['tax_rate', 'Tax rate'],
          ['tax_inclusive', 'Tax included'],
          ['capitalize_tax', 'Tax in stock value'],
          ['total', 'Order total'],
          ['stock_value', 'Inventory value'],
        ]}
      />
      {manage && author && status === 'draft' && (
        <button onClick={() => setEditing(!editing)}>Edit order</button>
      )}
      {receive && ['approved', 'partially_received'].includes(status) && (
        <button onClick={() => setReceiving(!receiving)}>
          Receive delivery
        </button>
      )}
      <div className="record-form">
        <label>
          Action reason
          <input
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {approve &&
          !author &&
          ['submitted', 'approved', 'partially_received'].includes(status) && (
            <label>
              Confirm your password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
        <div className="actions">
          {manage && author && status === 'draft' && (
            <button disabled={busy || !reason} onClick={() => act('submit')}>
              Submit order
            </button>
          )}
          {manage && author && ['draft', 'submitted'].includes(status) && (
            <button disabled={busy || !reason} onClick={() => act('cancel')}>
              Cancel order
            </button>
          )}
          {approve && !author && status === 'submitted' && (
            <>
              <button
                disabled={busy || !reason || !password}
                onClick={() => act('approve')}
              >
                Approve order
              </button>
              <button
                disabled={busy || !reason || !password}
                onClick={() => act('reject')}
              >
                Reject order
              </button>
            </>
          )}
          {approve &&
            !author &&
            ['approved', 'partially_received'].includes(status) && (
              <button
                disabled={busy || !reason || !password}
                onClick={() => act('close')}
              >
                Close unreceived remainder
              </button>
            )}
        </div>
        {author && status === 'submitted' && (
          <p>A different authorized reviewer must approve this order.</p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      {editing && (
        <OrderEditor
          base={base}
          initial={query.data}
          done={() => setEditing(false)}
        />
      )}
      {receiving && (
        <ReceiptEditor base={base} order={query.data} done={openReceipt} />
      )}
      <Grid
        title="Order history"
        rows={events}
        columns={[
          ['occurred_at', 'Date (UTC)'],
          ['action', 'Action'],
          ['actor', 'User'],
          ['reason', 'Reason'],
        ]}
      />
    </section>
  );
}
function ReceiptEditor({
  base,
  order,
  initial,
  done,
}: {
  base: string;
  order: OrderData;
  initial?: ReceiptData;
  done: (id: string) => void;
}) {
  const { write } = useSession();
  const [reference, setReference] = useState(
    text(initial?.receipt['supplier_reference']),
  );
  const [delivery, setDelivery] = useState(
    text(initial?.receipt['delivery_reference']),
  );
  const [note, setNote] = useState(text(initial?.receipt['note']));
  const [lines, setLines] = useState(
    order.lines.map((l) => ({
      orderItemId: text(l['id']),
      quantity:
        text(
          initial?.items.find((i) => i['order_item_id'] === l['id'])?.[
            'quantity'
          ],
        ) || '0',
      condition: (text(
        initial?.items.find((i) => i['order_item_id'] === l['id'])?.[
          'condition'
        ],
      ) || 'sellable') as PurchaseReceiptInput['lines'][number]['condition'],
    })),
  );
  const [requestKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="record-form no-print"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const receipt = {
          orderId: order.order['id'],
          supplierReference: reference,
          deliveryReference: delivery,
          note,
          lines: lines.filter(
            (l) => l.quantity !== '' && !/^0(\.0+)?$/.test(l.quantity),
          ),
        };
        void write<{ id: string }>(
          `${base}/receipts${initial ? '/' + text(initial.receipt['id']) : ''}`,
          initial
            ? { version: initial.receipt['version'], receipt }
            : { requestKey, receipt },
          initial ? 'PUT' : 'POST',
        )
          .then((r) => done(r.id))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <h2>
        {initial ? 'Edit receiving draft' : 'Receive an approved delivery'}
      </h2>
      <p>
        Enter purchase-unit quantities delivered now. Leave zero for lines not
        delivered. Excess quantities are rejected. Use a unique delivery
        reference for each physical posting; the invoice reference may repeat
        for partial deliveries.
      </p>
      <div className="form-grid">
        <label>
          Supplier invoice reference
          <input
            required
            maxLength={160}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <label>
          Unique delivery reference
          <input
            required
            maxLength={160}
            value={delivery}
            onChange={(e) => setDelivery(e.target.value)}
          />
        </label>
        <label>
          Receiving notes
          <input
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      {order.lines.map((l, i) => (
        <fieldset key={text(l['id'])}>
          <legend>
            {text((l['snapshot'] as Row)['sku'])} · remaining{' '}
            {text(l['outstanding'])} purchase units
          </legend>
          <div className="form-grid">
            <label>
              Delivered quantity
              <input
                required
                value={lines[i]!.quantity}
                onChange={(e) =>
                  setLines(
                    lines.map((line, n) =>
                      i === n ? { ...line, quantity: e.target.value } : line,
                    ),
                  )
                }
              />
            </label>
            <label>
              Received stock condition
              <select
                value={lines[i]!.condition}
                onChange={(e) =>
                  setLines(
                    lines.map((line, n) =>
                      i === n
                        ? {
                            ...line,
                            condition: e.target
                              .value as PurchaseReceiptInput['lines'][number]['condition'],
                          }
                        : line,
                    ),
                  )
                }
              >
                {['sellable', 'damaged', 'quarantined'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
      ))}
      <button disabled={busy}>Save receiving draft</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function ReceiptDetail({
  base,
  id,
  open,
}: {
  base: string;
  id: string;
  open: (id: string) => void;
}) {
  const { session, write } = useSession();
  const receive = useAllowed('purchasing.receive');
  const approve = useAllowed('purchasing.approve');
  const query = useData<ReceiptData>(`${base}/receipts/${id}`);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      const version = query.data!.receipt['version'];
      if (action === 'reverse') {
        const result = await write<{ id: string }>(`${base}/reversals`, {
          requestKey: key(`${session!.user.id}:${id}:reverse`),
          originalId: id,
          reason,
        });
        open(result.id);
      } else
        await write(`${base}/receipts/${id}/${action}`, {
          version,
          requestKey: key(`${session!.user.id}:${id}:${version}:${action}`),
          ...(action === 'approve-reversal' ? { password } : {}),
        });
      setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };
  if (!query.data) return <LoadState query={query} />;
  const { receipt, items, receiver, approver } = query.data;
  const snapshot = receipt['snapshot'] as Row;
  const author = receipt['actor_id'] === session!.user.id;
  const posted = receipt['status'] === 'posted';
  return (
    <section className="card history purchase-print">
      <h2>
        {receipt['kind'] === 'reversal'
          ? 'Receiving reversal'
          : 'Goods receipt'}{' '}
        {text(receipt['number']) || 'draft'}
      </h2>
      <p>
        {text(snapshot['branchName'])} · {text(snapshot['branchCode'])} ·
        Supplier: {text(snapshot['supplierName'])}
      </p>
      <p>
        Status: {text(receipt['status'])} · Order{' '}
        {text(snapshot['orderNumber'])} · Receiver: {receiver}
        {approver ? ` · Approver: ${approver}` : ''}
      </p>
      <p>
        Supplier reference: {text(receipt['supplier_reference'])} · Delivery
        reference: {text(receipt['delivery_reference'])}
      </p>
      <p>
        {text(receipt['note'])} · Posted:{' '}
        {text(receipt['posted_at']) || 'Not posted'}
      </p>
      {!!receipt['original_id'] && (
        <Link
          className="no-print"
          to={`/purchasing?receipt=${text(receipt['original_id'])}`}
        >
          Open original receipt
        </Link>
      )}
      <Grid
        title="Receiving document lines"
        rows={items.map((i) => ({
          ...i,
          sku: (i['snapshot'] as Row)['sku'],
          description: (i['snapshot'] as Row)['name'],
          unit: (i['snapshot'] as Row)['unit'],
          conversion: (i['snapshot'] as Row)['conversion'],
        }))}
        columns={[
          ['sku', 'SKU'],
          ['description', 'Description'],
          ['unit', 'Base unit'],
          ['quantity', 'Purchase units'],
          ['conversion', 'Conversion'],
          ['base_quantity', 'Base quantity'],
          ['condition', 'Condition'],
          ['discount', 'Discount'],
          ['net', 'Net'],
          ['tax', 'Tax'],
          ['total', 'Supplier total'],
          ['stock_value', 'Stock value'],
        ]}
      />
      <Grid
        title="Receiving cost and tax terms"
        rows={items.map((i) => i['snapshot'] as Row)}
        columns={[
          ['sku', 'SKU'],
          ['unitCost', 'Cost per purchase unit'],
          ['discountRate', 'Discount rate'],
          ['taxRate', 'Tax rate'],
          ['taxInclusive', 'Cost includes tax'],
          ['capitalizeTax', 'Tax in inventory value'],
        ]}
      />
      {posted && (
        <p>
          Totals (PHP): net {text(receipt['net'])} · tax {text(receipt['tax'])}{' '}
          · supplier total {text(receipt['total'])} · stock value{' '}
          {text(receipt['stock_value'])}
        </p>
      )}
      <div className="no-print">
        <div className="actions">
          {posted && (
            <button onClick={() => window.print()}>
              Print receiving document
            </button>
          )}
          {!posted && receipt['status'] === 'draft' && receive && author && (
            <>
              <button disabled={busy} onClick={() => void act('cancel')}>
                Cancel receiving draft
              </button>
              {receipt['kind'] === 'receipt' && (
                <>
                  <button onClick={() => setEditing(!editing)}>
                    Edit / refresh receiving draft
                  </button>
                  <button disabled={busy} onClick={() => void act('post')}>
                    Post goods receipt
                  </button>
                </>
              )}
            </>
          )}
        </div>
        {!posted &&
          receipt['status'] === 'draft' &&
          receipt['kind'] === 'reversal' &&
          approve &&
          !author && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act('approve-reversal');
              }}
            >
              <label>
                Reviewer password
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button disabled={busy}>Approve receipt reversal</button>
            </form>
          )}
        {posted && receipt['kind'] === 'receipt' && receive && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act('reverse');
            }}
          >
            <p>
              A full reversal needs a second reviewer. Later stock movements or
              insufficient unreserved stock block reversal.
            </p>
            <label>
              Reversal reason
              <input
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button disabled={busy}>Request full reversal</button>
          </form>
        )}
        {!posted && receipt['kind'] === 'reversal' && author && (
          <p>A different authorized reviewer must approve this reversal.</p>
        )}
        {error && <p role="alert">{error}</p>}
        {editing && (
          <EditReceipt
            base={base}
            receipt={query.data}
            done={() => setEditing(false)}
          />
        )}
      </div>
    </section>
  );
}
function EditReceipt({
  base,
  receipt,
  done,
}: {
  base: string;
  receipt: ReceiptData;
  done: () => void;
}) {
  const order = useData<OrderData>(
    `${base}/orders/${text(receipt.receipt['order_id'])}`,
  );
  return order.data ? (
    <ReceiptEditor
      base={base}
      order={order.data}
      initial={receipt}
      done={done}
    />
  ) : (
    <LoadState query={order} />
  );
}
