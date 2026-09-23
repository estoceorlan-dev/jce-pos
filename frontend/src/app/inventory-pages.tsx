import { useState } from 'react';
import type { StockDocumentInput } from '@jce/shared';
import { useAllowed, useData, useSession } from './session';
import { Grid, LoadState, text, type Row } from './forms';

type PageRows = { rows: Row[]; hasMore: boolean };
type DraftLine = StockDocumentInput['lines'][number] & { sku: string };
const blank = (): StockDocumentInput => ({
  kind: 'adjustment',
  reasonCode: 'FOUND',
  note: '',
  sourceReference: '',
  sourceDocumentId: null,
  openingDate: null,
  lines: [],
});
function actionKey(scope: string) {
  const key = `jce-stock:${scope}`;
  const prior = sessionStorage.getItem(key);
  if (prior) return prior;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}
function Pager({
  page,
  setPage,
  hasMore,
}: {
  page: number;
  setPage: (p: number) => void;
  hasMore: boolean;
}) {
  return (
    <div className="actions">
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
export function Inventory() {
  const { session, write } = useSession();
  const base = `/branches/${session!.branchId}/inventory`;
  const manage = useAllowed('inventory.manage');
  const reserve = useAllowed('inventory.reserve');
  const [tab, setTab] = useState('stock');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const stock = useData<PageRows>(
    `${base}?q=${encodeURIComponent(q)}&filter=${filter}&page=${page}`,
  );
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [movement, setMovement] = useState<Row | null>(null);
  const [draft, setDraft] = useState<StockDocumentInput | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [edit, setEdit] = useState<{ id: string; version: number } | null>(
    null,
  );
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reservation, setReservation] = useState<Row | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [reference, setReference] = useState('');
  const [reservationKey, setReservationKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [showImport, setShowImport] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };
  const add = (row: Row) => {
    if (!draft) {
      setDraft(blank());
      setDraftKey(crypto.randomUUID());
      setEdit(null);
      setLines([]);
    }
    setLines((prior) => [
      ...(draft ? prior : []),
      {
        variantId: text(row['variant_id']),
        sku: text(row['sku']),
        condition: 'sellable',
        quantity: text(row['on_hand']),
        unitCost: text(row['average_cost']),
      },
    ]);
    setDocumentId(null);
  };
  return (
    <div className="inventory-page">
      <h1>Inventory</h1>
      <p>
        Quantities are in base units. Available stock excludes reservations,
        damaged goods and quarantine.
      </p>
      <div className="actions" aria-label="Inventory views">
        {['stock', 'documents', 'reservations', 'reconciliation'].map((t) => (
          <button
            key={t}
            className={tab === t ? '' : 'secondary'}
            onClick={() => {
              setTab(t);
              setDocumentId(null);
              setMovement(null);
            }}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {tab === 'stock' && (
        <>
          <div className="toolbar">
            <label>
              Search stock
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
              Stock filter
              <select
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              >
                {[
                  ['all', 'All stock'],
                  ['low', 'Low stock'],
                  ['out', 'Out of stock'],
                  ['damaged', 'Damaged'],
                  ['quarantined', 'Quarantined'],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {manage && (
              <button onClick={() => setShowImport(!showImport)}>
                Import opening stock
              </button>
            )}
          </div>
          <LoadState query={stock} />
          {stock.data && (
            <>
              <Grid
                title="Branch stock"
                rows={stock.data.rows}
                columns={[
                  ['sku', 'SKU'],
                  ['product_name', 'Product'],
                  ['unit', 'Base unit'],
                  ['on_hand', 'Sellable on hand'],
                  ['reserved', 'Reserved'],
                  ['available', 'Available'],
                  ['damaged', 'Damaged'],
                  ['quarantined', 'Quarantined'],
                  ['average_cost', 'Average cost (PHP)'],
                  ['total_value', 'Total value (PHP)'],
                  ['frozen', 'Count freeze'],
                ]}
                actions={(row) => (
                  <div className="actions">
                    <button onClick={() => setMovement(row)}>Movements</button>
                    {manage && (
                      <button
                        disabled={
                          !!edit ||
                          lines.some(
                            (l) =>
                              l.variantId === row['variant_id'] &&
                              l.condition === 'sellable',
                          )
                        }
                        onClick={() => add(row)}
                      >
                        Add to document
                      </button>
                    )}
                    {reserve && (
                      <button
                        onClick={() => {
                          setReservation(row);
                          setReservationKey(crypto.randomUUID());
                        }}
                      >
                        Reserve
                      </button>
                    )}
                  </div>
                )}
              />
              <Pager
                page={page}
                setPage={setPage}
                hasMore={stock.data.hasMore}
              />
            </>
          )}
          {showImport && (
            <OpeningImport
              base={base}
              opened={(id) => {
                setDocumentId(id);
                setShowImport(false);
              }}
            />
          )}
        </>
      )}
      {tab === 'documents' && <Documents base={base} open={setDocumentId} />}
      {tab === 'reservations' && <Reservations base={base} />}
      {tab === 'reconciliation' && (
        <Reconciliation
          base={base}
          correction={(row) => {
            setDraft({
              ...blank(),
              kind: 'reconcile',
              reasonCode: 'RECONCILIATION',
            });
            setLines([
              {
                variantId: text(row['variant_id']),
                sku: text(row['sku']),
                condition: row['condition'] as DraftLine['condition'],
                quantity: '0',
                unitCost: '0',
              },
            ]);
            setEdit(null);
            setDraftKey(crypto.randomUUID());
            setDocumentId(null);
          }}
        />
      )}
      {reservation && (
        <form
          className="record-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await write(`${base}/reservations`, {
                requestKey: reservationKey,
                variantId: reservation['variant_id'],
                quantity,
                reference,
              });
              setReservation(null);
            });
          }}
        >
          <h2>Reserve {text(reservation['sku'])}</h2>
          <label>
            Reservation quantity
            <input
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          <label>
            Reservation reference
            <input
              required
              maxLength={160}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <div className="actions">
            <button disabled={busy}>Allocate reservation</button>
            <button type="button" onClick={() => setReservation(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {draft && (
        <form
          className="record-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const document = {
                ...draft,
                lines: lines.map(({ sku: _sku, ...line }) => line),
              };
              const result = await write<{ id: string }>(
                `${base}/documents${edit ? '/' + edit.id : ''}`,
                edit
                  ? { version: edit.version, document }
                  : { requestKey: draftKey, document },
                edit ? 'PUT' : 'POST',
              );
              setDraft(null);
              setLines([]);
              setEdit(null);
              setDocumentId(result.id);
            });
          }}
        >
          <h2>{edit ? 'Edit stock draft' : 'New stock document'}</h2>
          <p>
            For a count, save the scope to freeze these items before physically
            counting. Edit the saved draft to enter counted totals, then ask
            another authorized user to review and post.
          </p>
          <div className="form-grid">
            <label>
              Document kind
              <select
                disabled={!!edit}
                value={draft.kind}
                onChange={(e) => {
                  const kind = e.target.value as StockDocumentInput['kind'];
                  setDraft({
                    ...draft,
                    kind,
                    reasonCode:
                      kind === 'opening'
                        ? 'OPENING'
                        : kind === 'count'
                          ? 'COUNT_VARIANCE'
                          : kind === 'reconcile'
                            ? 'RECONCILIATION'
                            : 'FOUND',
                    openingDate:
                      kind === 'opening'
                        ? new Date().toLocaleDateString('en-CA', {
                            timeZone: 'Asia/Manila',
                          })
                        : null,
                  });
                }}
              >
                {['opening', 'adjustment', 'count', 'reconcile'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              Reason code
              <select
                value={draft.reasonCode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    reasonCode: e.target
                      .value as StockDocumentInput['reasonCode'],
                  })
                }
              >
                {[
                  'OPENING',
                  'COUNT_VARIANCE',
                  'DAMAGE',
                  'LOSS',
                  'FOUND',
                  'CORRECTION',
                  'RECONCILIATION',
                ].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              Reason / review notes
              <input
                required
                maxLength={500}
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </label>
            <label>
              Source / manifest reference
              <input
                required={draft.kind === 'opening'}
                maxLength={160}
                value={draft.sourceReference}
                onChange={(e) =>
                  setDraft({ ...draft, sourceReference: e.target.value })
                }
              />
            </label>
            <label>
              Original document ID (correction)
              <input
                required={draft.reasonCode === 'CORRECTION'}
                value={draft.sourceDocumentId ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    sourceDocumentId: e.target.value || null,
                  })
                }
              />
            </label>
            {draft.kind === 'opening' && (
              <label>
                Opening stock date
                <input
                  type="date"
                  required
                  value={draft.openingDate ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, openingDate: e.target.value })
                  }
                />
              </label>
            )}
          </div>
          {lines.map((line, index) => (
            <fieldset key={`${line.variantId}-${index}`}>
              <legend>{line.sku}</legend>
              <div className="form-grid">
                <label>
                  Condition
                  <select
                    disabled={!!edit && draft.kind === 'count'}
                    value={line.condition}
                    onChange={(e) =>
                      setLines(
                        lines.map((l, i) =>
                          i === index
                            ? {
                                ...l,
                                condition: e.target
                                  .value as DraftLine['condition'],
                              }
                            : l,
                        ),
                      )
                    }
                  >
                    {['sellable', 'damaged', 'quarantined'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {draft.kind === 'count'
                    ? 'Counted quantity'
                    : draft.kind === 'adjustment'
                      ? 'Quantity change (+ / −)'
                      : 'Quantity'}
                  <input
                    required
                    disabled={draft.kind === 'reconcile'}
                    value={line.quantity}
                    onChange={(e) =>
                      setLines(
                        lines.map((l, i) =>
                          i === index ? { ...l, quantity: e.target.value } : l,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Cost per base unit (PHP; additions)
                  <input
                    required
                    disabled={draft.kind === 'reconcile'}
                    value={line.unitCost}
                    onChange={(e) =>
                      setLines(
                        lines.map((l, i) =>
                          i === index ? { ...l, unitCost: e.target.value } : l,
                        ),
                      )
                    }
                  />
                </label>
              </div>
              {!(edit && draft.kind === 'count') && (
                <button
                  type="button"
                  onClick={() => setLines(lines.filter((_, i) => i !== index))}
                >
                  Remove line
                </button>
              )}
            </fieldset>
          ))}
          <p>
            Add more products from the stock list. Deductions use the current
            average cost. Reconciliation corrections restore only the reviewed
            cached balance from its ledger.
          </p>
          <div className="actions">
            <button disabled={busy || !lines.length}>
              Save draft for review
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setLines([]);
                setEdit(null);
              }}
            >
              Close editor
            </button>
          </div>
        </form>
      )}
      {movement && (
        <Movements base={base} row={movement} open={setDocumentId} />
      )}
      {documentId && (
        <Document
          key={documentId}
          base={base}
          id={documentId}
          edit={(doc, items) => {
            setDraft(doc.manifest as StockDocumentInput);
            setEdit({ id: text(doc['id']), version: Number(doc['version']) });
            setLines(
              items.map((i) => ({
                variantId: text(i['variant_id']),
                condition: i['condition'] as DraftLine['condition'],
                quantity: text(i['quantity']),
                unitCost: text(i['unit_cost']),
                sku: text((i['snapshot'] as Row)['sku']),
              })),
            );
            setDocumentId(null);
          }}
        />
      )}
    </div>
  );
}
function Documents({
  base,
  open,
}: {
  base: string;
  open: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const query = useData<PageRows>(`${base}/documents?page=${page}`);
  return (
    <section>
      <h2>Stock documents</h2>
      <LoadState query={query} />
      {query.data && (
        <>
          <Grid
            title="Stock documents"
            rows={query.data.rows}
            columns={[
              ['number', 'Number'],
              ['kind', 'Kind'],
              ['status', 'Status'],
              ['author', 'Author'],
              ['note', 'Notes'],
            ]}
            actions={(r) => (
              <button onClick={() => open(text(r['id']))}>
                Review document
              </button>
            )}
          />
          <Pager page={page} setPage={setPage} hasMore={query.data.hasMore} />
        </>
      )}
    </section>
  );
}
function Document({
  base,
  id,
  edit,
}: {
  base: string;
  id: string;
  edit: (doc: Row, items: Row[]) => void;
}) {
  const { session, write } = useSession();
  const approve = useAllowed('inventory.approve');
  const manage = useAllowed('inventory.manage');
  const query = useData<{
    document: Row;
    items: Row[];
    totalValueChange: string;
  }>(`${base}/documents/${id}`);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      const version = query.data!.document['version'];
      await write(`${base}/documents/${id}/${action}`, {
        version,
        requestKey: actionKey(`${session!.user.id}:${id}:${version}:${action}`),
        ...(action === 'post' ? { password } : {}),
      });
      setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };
  const doc = query.data?.document;
  return (
    <section className="card history">
      <h2>Stock document review</h2>
      <LoadState query={query} />
      {doc && query.data && (
        <>
          <p>
            <strong>
              {text(doc['number']) || 'Draft'} · {text(doc['kind'])} ·{' '}
              {text(doc['status'])}
            </strong>
          </p>
          <p>
            Document ID: {id} · Version {text(doc['version'])}
          </p>
          <p>
            {text(doc['reason_code'])}: {text(doc['note'])}
          </p>
          <p>
            Source: {text(doc['source_reference']) || 'Manual entry'}
            {!!doc['source_document_id'] &&
              ` · Corrects ${text(doc['source_document_id'])}`}
          </p>
          <p>
            Opening date:{' '}
            {text((doc['manifest'] as Row)['openingDate']) || 'Not applicable'}{' '}
            · Posted: {text(doc['posted_at']) || 'Pending review'}
          </p>
          <Grid
            title="Stock reconciliation preview"
            rows={query.data.items.map((i) => ({
              ...i,
              sku: (i['snapshot'] as Row)['sku'],
            }))}
            columns={[
              ['sku', 'SKU'],
              ['condition', 'Condition'],
              ['expected_quantity', 'Before'],
              ['delta', 'Change'],
              ['resulting_quantity', 'After'],
              ['expected_value', 'Value before'],
              ['value_change', 'Value change'],
              ['resulting_value', 'Value after'],
            ]}
          />
          <p>Total value change: PHP {query.data.totalValueChange}</p>
          <a href={`/api/v1${base}/documents/${id}/report`} download>
            Download reconciliation report (CSV)
          </a>
          {doc['status'] === 'draft' && (
            <div className="actions">
              {manage && doc['actor_id'] === session!.user.id && (
                <button onClick={() => edit(doc, query.data!.items)}>
                  Edit / refresh draft
                </button>
              )}
              {manage && (
                <button disabled={busy} onClick={() => void act('cancel')}>
                  Cancel draft / release count
                </button>
              )}
            </div>
          )}
          {doc['status'] === 'draft' &&
            approve &&
            doc['actor_id'] !== session!.user.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('post');
                }}
              >
                <p>
                  Confirm the quantities, values, reason and source above.
                  Approval and posting occur together.
                </p>
                <label>
                  Your password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <button disabled={busy}>Approve and post</button>
              </form>
            )}
          {doc['status'] === 'draft' &&
            doc['actor_id'] === session!.user.id && (
              <p>
                A different authorized user must sign in to approve this
                document.
              </p>
            )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function Movements({
  base,
  row,
  open,
}: {
  base: string;
  row: Row;
  open: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const query = useData<PageRows>(
    `${base}/movements/${text(row['variant_id'])}?page=${page}`,
  );
  return (
    <section className="card history">
      <h2>Movements: {text(row['sku'])}</h2>
      <LoadState query={query} />
      {query.data && (
        <>
          <Grid
            title="Movement ledger"
            rows={query.data.rows}
            columns={[
              ['occurred_at', 'Posted (UTC)'],
              ['condition', 'Condition'],
              ['quantity', 'Quantity change'],
              ['value', 'Value change'],
              ['number', 'Document'],
            ]}
            actions={(r) => (
              <button onClick={() => open(text(r['source_id']))}>
                Open source document
              </button>
            )}
          />
          <Pager page={page} setPage={setPage} hasMore={query.data.hasMore} />
        </>
      )}
    </section>
  );
}
function Reservations({ base }: { base: string }) {
  const { session, write } = useSession();
  const allowed = useAllowed('inventory.reserve');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const query = useData<PageRows>(`${base}/reservations?page=${page}`);
  return (
    <section>
      <h2>Stock reservations</h2>
      <LoadState query={query} />
      {error && <p role="alert">{error}</p>}
      {query.data && (
        <>
          <Grid
            title="Reservations"
            rows={query.data.rows}
            columns={[
              ['sku', 'SKU'],
              ['quantity', 'Quantity'],
              ['reference', 'Reference'],
              ['status', 'Status'],
            ]}
            actions={(r) =>
              allowed && r['status'] === 'active' ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError('');
                    void write(
                      `${base}/reservations/${text(r['id'])}/release`,
                      {
                        requestKey: actionKey(
                          `${session!.user.id}:${text(r['id'])}:release`,
                        ),
                      },
                    )
                      .catch((e: Error) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Release
                </button>
              ) : null
            }
          />
          <Pager page={page} setPage={setPage} hasMore={query.data.hasMore} />
        </>
      )}
    </section>
  );
}
function Reconciliation({
  base,
  correction,
}: {
  base: string;
  correction: (r: Row) => void;
}) {
  const query = useData<{ matched: boolean; rows: Row[] }>(
    `${base}/reconciliation`,
  );
  const manage = useAllowed('inventory.manage');
  return (
    <section>
      <h2>Ledger reconciliation</h2>
      <p>
        This check compares balances with movements and active reservations. Any
        correction requires review.
      </p>
      <button onClick={() => void query.refetch()}>Run reconciliation</button>
      <LoadState query={query} />
      {query.data && (
        <>
          <p role="status">
            {query.data.matched
              ? 'All balances reconcile.'
              : 'Discrepancies found. Stock changes are blocked for affected balances.'}
          </p>
          <Grid
            title="Reconciliation differences"
            rows={query.data.rows.filter((r) => !r['matched'])}
            columns={[
              ['sku', 'SKU'],
              ['condition', 'Condition'],
              ['balance_quantity', 'Balance quantity'],
              ['ledger_quantity', 'Ledger quantity'],
              ['balance_value', 'Balance value'],
              ['ledger_value', 'Ledger value'],
              ['balance_reserved', 'Reserved'],
              ['ledger_reserved', 'Reservation total'],
            ]}
            actions={(r) =>
              manage ? (
                <button onClick={() => correction(r)}>
                  Draft reviewed correction
                </button>
              ) : null
            }
          />
        </>
      )}
    </section>
  );
}
function OpeningImport({
  base,
  opened,
}: {
  base: string;
  opened: (id: string) => void;
}) {
  const { write } = useSession();
  const [csv, setCsv] = useState('sku,condition,quantity,unitCost\n');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        void write<{ id: string }>(`${base}/import`, {
          requestKey: key,
          csv,
          sourceReference: reference,
          openingDate: date,
          note,
        })
          .then((r) => opened(r.id))
          .catch((e: Error) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <h2>Opening stock import</h2>
      <p>
        Paste up to 100 rows with the header shown below. All rows validate
        together and create a reviewable draft. No stock changes until another
        authorized user approves it.
      </p>
      <label>
        CSV manifest
        <textarea
          required
          rows={8}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
      </label>
      <label>
        Manifest source reference
        <input
          required
          maxLength={160}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </label>
      <label>
        Opening date
        <input
          required
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <label>
        Import review notes
        <input
          required
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button disabled={busy}>Validate and create opening draft</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
