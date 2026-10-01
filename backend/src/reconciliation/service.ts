import { randomUUID } from 'node:crypto';
import type { CorrectionInput } from '@jce/shared';
import type { Transaction } from '../db/transaction.js';
import { decimal } from '../db/decimal.js';
import { checksum } from '../db/canonical.js';
import { allocateDocumentNumber } from '../db/numbering.js';
import { requireFound, HttpError } from '../management/common.js';
import {
  applyMovement,
  lockInventory,
  installation,
  conflict,
} from '../inventory/ledger.js';
import { liveSession, checkoutEvent, eligible } from '../checkout/service.js';
import { returnShare } from './calculations.js';

export async function eligibility(
  tx: Transaction,
  branch: string,
  saleId: string,
) {
  const sale = requireFound(
    (
      await tx.query(
        "SELECT * FROM sales WHERE id=$1 AND branch_id=$2 AND status='posted' FOR UPDATE",
        [saleId, branch],
      )
    ).rows[0],
  );
  const lines = (
    await tx.query(
      `SELECT i.*,COALESCE((SELECT sum(r.quantity) FROM sales_return_items r WHERE r.sale_item_id=i.id),0)::text returned,
    (i.quantity-COALESCE((SELECT sum(r.quantity) FROM sales_return_items r WHERE r.sale_item_id=i.id),0))::text eligible FROM sale_items i WHERE i.sale_id=$1 ORDER BY i.id`,
      [saleId],
    )
  ).rows;
  const returns = (
    await tx.query(
      'SELECT id,number,reversal,total,reason_code,posted_at FROM sales_returns WHERE sale_id=$1 ORDER BY posted_at,id',
      [saleId],
    )
  ).rows;
  return { sale, lines, returns };
}
export async function summary(
  tx: Transaction,
  branch: string,
  sessionId: string,
) {
  const session = requireFound(
    (
      await tx.query(
        'SELECT * FROM register_sessions WHERE id=$1 AND branch_id=$2 FOR UPDATE',
        [sessionId, branch],
      )
    ).rows[0],
  );
  const sales = (
    await tx.query(
      `SELECT COALESCE(sum(total),0)::text total,COALESCE(sum(change),0)::text change,count(*)::int count FROM sales WHERE session_id=$1`,
      [sessionId],
    )
  ).rows[0]!;
  const refunds = (
    await tx.query(
      'SELECT COALESCE(sum(total),0)::text total,count(*)::int count FROM sales_returns WHERE session_id=$1',
      [sessionId],
    )
  ).rows[0]!;
  const tenders = (
    await tx.query(
      `SELECT m.method,COALESCE((SELECT sum(p.applied) FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.session_id=$1 AND p.method=m.method),0)::text sales,
    COALESCE((SELECT sum(p.amount) FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.session_id=$1 AND p.method=m.method),0)::text tendered,
    COALESCE((SELECT sum(p.amount) FROM refund_payments p JOIN sales_returns r ON r.id=p.return_id WHERE r.session_id=$1 AND p.method=m.method),0)::text refunds
    FROM (VALUES ('cash'),('card'),('ewallet')) m(method)`,
      [sessionId],
    )
  ).rows;
  const movements = (
    await tx.query(
      `SELECT COALESCE(sum(amount) FILTER(WHERE kind='paid_in'),0)::text paid_in,COALESCE(sum(amount) FILTER(WHERE kind='paid_out'),0)::text paid_out,COALESCE(sum(amount) FILTER(WHERE kind='safe_drop'),0)::text safe_drop,count(*)::int count FROM cash_movements WHERE session_id=$1`,
      [sessionId],
    )
  ).rows[0]!;
  const expected: Record<string, string> = {};
  for (const t of tenders)
    expected[t.method as string] = decimal(t.sales as string)
      .minus(t.refunds as string)
      .toFixed(2);
  expected['cash'] = decimal(expected['cash']!)
    .plus(session.opening_float as string)
    .plus(movements.paid_in as string)
    .minus(movements.paid_out as string)
    .minus(movements.safe_drop as string)
    .toFixed(2);
  const netSales = decimal(sales.total as string)
    .minus(refunds.total as string)
    .toFixed(2);
  const netPayments = tenders
    .reduce(
      (sum, t) => sum.plus(t.sales as string).minus(t.refunds as string),
      decimal('0'),
    )
    .toFixed(2);
  return {
    session,
    sales,
    refunds,
    tenders,
    movements,
    expected,
    netSales,
    netPayments,
  };
}
type ReturnLine = {
  name: string;
  saleItemId: string;
  variantId: string;
  quantity: string;
  baseQuantity: string;
  condition: 'sellable' | 'damaged' | 'quarantined';
  discount: string;
  net: string;
  tax: string;
  total: string;
  cost: string;
  prior: string;
};
type ReturnQuote = {
  lines: ReturnLine[];
  net: string;
  tax: string;
  total: string;
  saleNumber: string;
  customerId: string | null;
};
export async function quoteReturn(
  tx: Transaction,
  branch: string,
  input: Extract<CorrectionInput, { kind: 'return' }>,
  validatePayments = true,
): Promise<ReturnQuote> {
  const original = await eligibility(tx, branch, input.saleId);
  if (
    input.reversal &&
    (original.returns.length || input.lines.length !== original.lines.length)
  )
    throw conflict(
      'A full reversal requires all original lines and no prior returns. Return only the remaining eligible units instead.',
    );
  const lines: ReturnLine[] = [];
  for (const requested of input.lines) {
    const line = requireFound(
      original.lines.find((l) => l.id === requested.saleItemId),
    );
    if (decimal(requested.quantity).gt(line.eligible as string))
      throw conflict(
        'Return quantity exceeds the remaining original quantity.',
      );
    if (
      input.reversal &&
      !decimal(requested.quantity).eq(line.quantity as string)
    )
      throw conflict('A reversal must include the full original quantities.');
    const share = (field: string, scale = 2) =>
      returnShare(
        line[field] as string,
        line.quantity as string,
        line.returned as string,
        requested.quantity,
        scale,
      );
    // Use the original conversion and fraction policy, never current catalog prices.
    const snapshot = line.snapshot as {
      conversion: string;
      fractional: boolean;
    };
    const base = decimal(requested.quantity).times(snapshot.conversion);
    if (base.decimalPlaces() > 6 || (!snapshot.fractional && !base.isInteger()))
      throw conflict(
        'Return quantity does not match the original base-unit rules.',
      );
    const net = share('net'),
      tax = share('tax');
    lines.push({
      ...requested,
      name: (line.snapshot as { name: string }).name,
      variantId: line.variant_id as string,
      baseQuantity: base.toFixed(6),
      discount: share('discount'),
      net,
      tax,
      total: decimal(net).plus(tax).toFixed(2),
      cost: share('cost', 6),
      prior: line.returned as string,
    });
  }
  const sum = (field: 'net' | 'tax' | 'total') =>
    lines.reduce((n, l) => n.plus(l[field]), decimal('0')).toFixed(2);
  const total = sum('total');
  if (
    validatePayments &&
    !input.payments.reduce((n, p) => n.plus(p.amount), decimal('0')).eq(total)
  )
    throw conflict(`Refund tenders must equal ${total}.`);
  const originalMethods = (
    await tx.query(
      `SELECT p.method,(p.applied-COALESCE((SELECT sum(rp.amount) FROM refund_payments rp JOIN sales_returns r ON r.id=rp.return_id WHERE r.sale_id=p.sale_id AND rp.method=p.method),0))::text remaining FROM sale_payments p WHERE p.sale_id=$1`,
      [input.saleId],
    )
  ).rows;
  for (const p of input.payments) {
    const original = originalMethods.find((m) => m.method === p.method);
    if (
      !original ||
      decimal(p.amount).gt(original.remaining as string) ||
      (p.method !== 'cash' && !p.reference)
    )
      throw conflict(
        'Use remaining original tender amounts and a reference for noncash refunds.',
      );
  }
  return {
    lines,
    net: sum('net'),
    tax: sum('tax'),
    total,
    saleNumber: original.sale.number as string,
    customerId: original.sale.customer_id as string | null,
  };
}
export const actionPermission = (d: CorrectionInput) =>
  d.kind === 'return'
    ? 'returns.use'
    : d.kind === 'close'
      ? 'register.close'
      : 'checkout.use';
export const approvalPermission = (d: CorrectionInput) =>
  d.kind === 'return' ? 'returns.approve' : 'cash.approve';
export const needsApproval = (d: CorrectionInput) =>
  d.kind !== 'cash' || d.movement !== 'paid_in';
export async function quote(
  tx: Transaction,
  branch: string,
  actor: string,
  input: CorrectionInput,
) {
  await eligible(tx, branch, actor, actionPermission(input));
  await liveSession(tx, branch, actor, input.sessionId);
  if (input.kind === 'return') return quoteReturn(tx, branch, input);
  if (input.kind === 'cash')
    return {
      movement: input.movement,
      amount: decimal(input.amount).toFixed(2),
    };
  if (
    (
      await tx.query(
        "SELECT 1 FROM checkout_carts WHERE session_id=$1 AND status IN ('active','held') LIMIT 1",
        [input.sessionId],
      )
    ).rowCount
  )
    throw conflict('Post or discard active and held carts before closing.');
  return JSON.parse(
    JSON.stringify(await summary(tx, branch, input.sessionId)),
  ) as Awaited<ReturnType<typeof summary>>;
}
export async function getRequest(
  tx: Transaction,
  branch: string,
  id: string,
  lock = false,
) {
  return requireFound(
    (
      await tx.query<{
        id: string;
        actor_id: string;
        input: CorrectionInput;
        quote: ReturnQuote;
        status: string;
      }>(
        `SELECT * FROM correction_requests WHERE id=$1 AND branch_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [id, branch],
      )
    ).rows[0],
  );
}
export async function createRequest(
  tx: Transaction,
  branch: string,
  actor: string,
  input: CorrectionInput,
) {
  const quoted = await quote(tx, branch, actor, input),
    id = randomUUID();
  await tx.query(
    'INSERT INTO correction_requests(id,branch_id,actor_id,session_id,kind,input,quote) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      id,
      branch,
      actor,
      input.sessionId,
      input.kind,
      JSON.stringify(input),
      JSON.stringify(quoted),
    ],
  );
  await checkoutEvent(tx, branch, actor, id, 1, 'correction', 'created');
  return { id };
}
export async function approveRequest(
  tx: Transaction,
  branch: string,
  actor: string,
  id: string,
) {
  const r = await getRequest(tx, branch, id, true);
  if (r.actor_id === actor)
    throw new HttpError(
      403,
      'SELF_APPROVAL',
      'A different manager must review this request.',
    );
  if (r.status !== 'pending') throw conflict('This request is already posted.');
  await eligible(tx, branch, actor, approvalPermission(r.input));
  const current = await quote(tx, branch, r.actor_id, r.input);
  if (checksum(current) !== checksum(r.quote))
    throw conflict(
      'Eligibility or register totals changed. Create a new request for review.',
    );
  const approvalId = randomUUID();
  await tx.query(
    "INSERT INTO correction_approvals(id,request_id,actor_id,quote_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes')",
    [approvalId, id, actor, checksum({ input: r.input, quote: r.quote })],
  );
  await checkoutEvent(tx, branch, actor, approvalId, 1, 'approval', 'approved');
  return { id: approvalId };
}
export async function postRequest(
  tx: Transaction,
  branch: string,
  actor: string,
  id: string,
) {
  const r = await getRequest(tx, branch, id, true);
  if (r.actor_id !== actor)
    throw new HttpError(
      403,
      'AUTHOR_REQUIRED',
      'Only the requesting cashier can post this request.',
    );
  await eligible(tx, branch, actor, actionPermission(r.input));
  if (r.status === 'posted') return { id }; // Document identity is a second retry guard.
  const current = await quote(tx, branch, actor, r.input);
  if (checksum(current) !== checksum(r.quote))
    throw conflict(
      'Eligibility or register totals changed. Create a new request for review.',
    );
  let approvalId: string | null = null;
  if (needsApproval(r.input)) {
    const approval = (
      await tx.query<{ id: string; actor_id: string }>(
        'SELECT id,actor_id FROM correction_approvals WHERE request_id=$1 AND actor_id<>$2 AND quote_hash=$3 AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1',
        [id, actor, checksum({ input: r.input, quote: r.quote })],
      )
    ).rows[0];
    if (!approval)
      throw conflict(
        'This exact request requires a different manager approval within five minutes.',
      );
    await eligible(tx, branch, approval.actor_id, approvalPermission(r.input));
    approvalId = approval.id;
  }
  const d = r.input;
  if (d.kind === 'return') {
    const q = current as ReturnQuote,
      installationId = await installation(tx, branch);
    await lockInventory(
      tx,
      branch,
      q.lines.map((l) => l.variantId),
    );
    const number = `RET-${await allocateDocumentNumber(tx, { documentId: id, branchId: branch, installationId, series: 'RET' })}`;
    await tx.query(
      'INSERT INTO sales_returns(id,branch_id,sale_id,session_id,actor_id,approval_id,number,reversal,reason_code,reason,net,tax,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        id,
        branch,
        d.saleId,
        d.sessionId,
        actor,
        approvalId,
        number,
        d.reversal,
        d.reasonCode,
        d.reason,
        q.net,
        q.tax,
        q.total,
      ],
    );
    for (const l of q.lines) {
      const lineId = randomUUID();
      await tx.query(
        'INSERT INTO sales_return_items(id,return_id,sale_item_id,quantity,base_quantity,condition,discount,net,tax,total,cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          lineId,
          id,
          l.saleItemId,
          l.quantity,
          l.baseQuantity,
          l.condition,
          l.discount,
          l.net,
          l.tax,
          l.total,
          l.cost,
        ],
      );
      await applyMovement(tx, {
        installationId,
        branchId: branch,
        variantId: l.variantId,
        condition: l.condition,
        quantity: l.baseQuantity,
        unitCost: '0',
        valueChange: l.cost,
        originalSaleReturn: true,
        sourceType: d.reversal ? 'sale_reversal' : 'sale_return',
        sourceId: id,
        sourceLineId: lineId,
        actorId: actor,
      });
    }
    for (const p of d.payments)
      await tx.query(
        'INSERT INTO refund_payments(id,return_id,method,amount,reference) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), id, p.method, p.amount, p.reference],
      );
    if (q.customerId)
      await tx.query(
        "INSERT INTO customer_transactions(id,branch_id,customer_id,source_type,source_id,amount) VALUES($1,$2,$3,'refund',$4,$5)",
        [randomUUID(), branch, q.customerId, id, q.total],
      );
  } else if (d.kind === 'cash') {
    await tx.query(
      'INSERT INTO cash_movements(id,session_id,actor_id,approval_id,kind,amount,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, d.sessionId, actor, approvalId, d.movement, d.amount, d.reason],
    );
  } else {
    const q = current as Awaited<ReturnType<typeof summary>>;
    const variance = Object.fromEntries(
      Object.entries(d.counts).map(([k, v]) => [
        k,
        decimal(v).minus(q.expected[k]!).toFixed(2),
      ]),
    );
    await tx.query(
      'INSERT INTO register_closures(id,session_id,actor_id,approval_id,summary,counts,variance,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        d.sessionId,
        actor,
        approvalId,
        JSON.stringify(q),
        JSON.stringify(d.counts),
        JSON.stringify(variance),
        d.reason,
      ],
    );
    await tx.query(
      "UPDATE register_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",
      [d.sessionId],
    );
  }
  if (
    approvalId &&
    !(
      await tx.query(
        'SELECT 1 FROM correction_approvals WHERE id=$1 AND expires_at>clock_timestamp()',
        [approvalId],
      )
    ).rowCount
  )
    throw conflict('Approval expired before posting. Request review again.');
  await tx.query("UPDATE correction_requests SET status='posted' WHERE id=$1", [
    id,
  ]);
  await checkoutEvent(tx, branch, actor, id, 2, 'correction', 'posted');
  return { id };
}
