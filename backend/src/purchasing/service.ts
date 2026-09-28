import { randomUUID } from 'node:crypto';
import {
  purchaseOrderInput,
  purchaseReceiptInput,
  type StockCondition,
} from '@jce/shared';
import type { Transaction } from '../db/transaction.js';
import { decimal } from '../db/decimal.js';
import { allocateDocumentNumber } from '../db/numbering.js';
import { appendAudit } from '../audit/append.js';
import { appendOutbox } from '../sync/outbox.js';
import { HttpError, requireFound } from '../management/common.js';
import {
  applyMovement,
  balance,
  conflict,
  installation,
  lockInventory,
} from '../inventory/ledger.js';
import {
  baseQuantity,
  purchaseAmounts,
  receiptAmounts,
  type Terms,
} from './calculations.js';
type Snapshot = {
  sku: string;
  name: string;
  unit: string;
  fractional: boolean;
  conversion: string;
};
export type OrderLine = Terms & {
  id: string;
  variant_id: string;
  quantity: string;
  received: string;
  snapshot: Snapshot;
};
type Order = {
  id: string;
  branch_id: string;
  supplier_id: string;
  installation_id: string;
  status: string;
  version: number;
  actor_id: string;
  number: string;
  note: string;
  snapshot: Record<string, string>;
};
type Receipt = {
  id: string;
  branch_id: string;
  installation_id: string;
  order_id: string;
  supplier_id: string;
  kind: 'receipt' | 'reversal';
  status: string;
  version: number;
  actor_id: string;
  original_id: string | null;
  number: string | null;
  note: string;
  snapshot: Record<string, string>;
};
type ReceiptItem = {
  id: string;
  order_item_id: string;
  variant_id: string;
  condition: StockCondition;
  quantity: string;
  base_quantity: string;
  net: string;
  tax: string;
  total: string;
  discount: string;
  stock_value: string;
  balance_version: number;
  snapshot: Snapshot & { receivedBefore: string };
};
type Action =
  | 'drafted'
  | 'edited'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'closed'
  | 'posted'
  | 'received';
export async function purchaseEvent(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
  version: number,
  kind: 'order' | 'receipt' | 'reversal',
  action: Action,
  reason = '',
) {
  const installationId = await installation(tx, branchId);
  await appendAudit(tx, {
    installationId,
    branchId,
    actorId,
    requestId: randomUUID(),
    action: `purchasing.${action}`,
    entityType: kind === 'order' ? 'purchase_order' : 'purchase',
    entityId: id,
    entityVersion: version,
  });
  await appendOutbox(
    tx,
    { installationId, branchId, aggregateId: id, aggregateVersion: version },
    {
      eventType: 'purchasing.changed',
      aggregateType: 'purchasing',
      payload: { entityId: id, kind, action },
    },
  );
  if (kind === 'order')
    await tx.query(
      'INSERT INTO purchase_order_events(id,order_id,version,action,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), id, version, action, actorId, reason],
    );
}
export async function orderDetail(
  tx: Transaction,
  branchId: string,
  id: string,
  lock = false,
) {
  const order = requireFound(
    (
      await tx.query<Order>(
        `SELECT * FROM purchase_orders WHERE branch_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [branchId, id],
      )
    ).rows[0],
  );
  const lines = (
    await tx.query<OrderLine>(
      `SELECT oi.*,COALESCE((SELECT sum(CASE WHEN p.kind='receipt' THEN i.quantity ELSE -i.quantity END) FROM purchase_items i JOIN purchases p ON p.id=i.purchase_id WHERE i.order_item_id=oi.id AND p.status='posted'),0)::text received FROM purchase_order_items oi WHERE oi.order_id=$1 ORDER BY oi.id`,
      [id],
    )
  ).rows;
  return {
    order,
    lines: lines.map((l) => ({
      ...l,
      outstanding: decimal(l.quantity).minus(l.received).toFixed(6),
      ...purchaseAmounts(l, l.quantity),
    })),
  };
}
export async function receiptDetail(
  tx: Transaction,
  branchId: string,
  id: string,
  lock = false,
) {
  const receipt = requireFound(
    (
      await tx.query<Receipt>(
        `SELECT * FROM purchases WHERE branch_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [branchId, id],
      )
    ).rows[0],
  );
  const items = (
    await tx.query<ReceiptItem>(
      'SELECT * FROM purchase_items WHERE purchase_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  return { receipt, items };
}
async function activeSupplier(tx: Transaction, branchId: string, id: string) {
  return requireFound(
    (
      await tx.query<{ name: string }>(
        'SELECT name FROM suppliers WHERE branch_id=$1 AND id=$2 AND NOT archived',
        [branchId, id],
      )
    ).rows[0],
  );
}
async function activeVariant(tx: Transaction, id: string): Promise<Snapshot> {
  const row = requireFound(
    (
      await tx.query<Snapshot & { archived: boolean }>(
        `SELECT v.sku,p.name||' / '||v.name name,u.name unit,v.conversion,v.fractional,(v.archived OR p.archived OR u.archived) archived FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id WHERE v.id=$1`,
        [id],
      )
    ).rows[0],
  );
  if (row.archived) throw conflict('Choose an active variant and unit.');
  return {
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    conversion: row.conversion,
    fractional: row.fractional,
  };
}
function converted(quantity: string, conversion: string, fractional: boolean) {
  try {
    return baseQuantity(quantity, conversion, fractional);
  } catch {
    throw conflict(
      'Quantity must convert exactly to permitted base-unit quantities.',
    );
  }
}
function requireDraft(
  row: { status: string; version: number; actor_id: string },
  version: number,
  actorId: string,
) {
  if (row.status !== 'draft' || row.version !== version)
    throw conflict('Draft changed or was finalized. Reload before continuing.');
  if (row.actor_id !== actorId)
    throw new HttpError(
      403,
      'AUTHOR_REQUIRED',
      'Only the author can edit or post this draft.',
    );
}
async function requireEligibleAuthor(
  tx: Transaction,
  branchId: string,
  actorId: string,
  permission: string,
) {
  const row = await tx.query(
    'SELECT 1 FROM users u JOIN branch_users b ON b.user_id=u.id JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE u.id=$1 AND b.branch_id=$2 AND NOT u.disabled AND rp.permission_code=$3',
    [actorId, branchId, permission],
  );
  if (!row.rowCount)
    throw conflict(
      'The requesting user no longer has permission for this branch.',
    );
}
export async function saveOrder(
  tx: Transaction,
  branchId: string,
  actorId: string,
  input: unknown,
  edit?: { id: string; version: number },
) {
  const data = purchaseOrderInput.parse(input);
  const id = edit?.id ?? randomUUID();
  if (edit)
    requireDraft(
      (await orderDetail(tx, branchId, id, true)).order,
      edit.version,
      actorId,
    );
  const supplier = await activeSupplier(tx, branchId, data.supplierId);
  const installationId = await installation(tx, branchId);
  const branch = requireFound(
    (
      await tx.query<{ name: string; code: string }>(
        'SELECT name,code FROM branches WHERE id=$1',
        [branchId],
      )
    ).rows[0],
  );
  const lines = [];
  for (const l of data.lines) {
    const snapshot = await activeVariant(tx, l.variantId);
    converted(l.quantity, snapshot.conversion, snapshot.fractional);
    lines.push({ ...l, snapshot });
  }
  const snapshot = JSON.stringify({
    supplierName: supplier.name,
    branchName: branch.name,
    branchCode: branch.code,
  });
  const version = (edit?.version ?? 0) + 1;
  if (edit) {
    await tx.query('DELETE FROM purchase_order_items WHERE order_id=$1', [id]);
    await tx.query(
      'UPDATE purchase_orders SET supplier_id=$2,note=$3,snapshot=$4,version=$5 WHERE id=$1',
      [id, data.supplierId, data.note, snapshot, version],
    );
  } else {
    const number = `PO-${await allocateDocumentNumber(tx, { documentId: id, branchId, installationId, series: 'PO' })}`;
    await tx.query(
      'INSERT INTO purchase_orders(id,branch_id,installation_id,supplier_id,number,actor_id,note,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        branchId,
        installationId,
        data.supplierId,
        number,
        actorId,
        data.note,
        snapshot,
      ],
    );
  }
  for (const l of lines)
    await tx.query(
      'INSERT INTO purchase_order_items(id,order_id,variant_id,quantity,conversion,unit_cost,discount_rate,tax_rate,tax_inclusive,capitalize_tax,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        randomUUID(),
        id,
        l.variantId,
        l.quantity,
        l.snapshot.conversion,
        l.unitCost,
        l.discountRate,
        l.taxRate,
        l.taxInclusive,
        l.capitalizeTax,
        JSON.stringify(l.snapshot),
      ],
    );
  await purchaseEvent(
    tx,
    branchId,
    actorId,
    id,
    version,
    'order',
    edit ? 'edited' : 'drafted',
    data.note,
  );
  return { id, version };
}
export async function transitionOrder(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
  version: number,
  action: 'submit' | 'approve' | 'reject' | 'cancel' | 'close',
  reason: string,
) {
  const { order, lines } = await orderDetail(tx, branchId, id, true);
  if (order.version !== version) throw conflict('Order changed. Reload it.');
  const allowed = {
    submit: ['draft'],
    approve: ['submitted'],
    reject: ['submitted'],
    cancel: ['draft', 'submitted'],
    close: ['approved', 'partially_received'],
  };
  if (!allowed[action].includes(order.status))
    throw conflict(
      'This transition is not allowed from the current order status.',
    );
  if (['submit', 'cancel'].includes(action) && order.actor_id !== actorId)
    throw new HttpError(
      403,
      'AUTHOR_REQUIRED',
      'Only the author can submit or cancel this order.',
    );
  if (
    ['approve', 'reject', 'close'].includes(action) &&
    order.actor_id === actorId
  )
    throw new HttpError(
      403,
      'SELF_APPROVAL',
      'A different authorized reviewer must perform this action.',
    );
  if (['submit', 'approve'].includes(action)) {
    await activeSupplier(tx, branchId, order.supplier_id);
    for (const l of lines) await activeVariant(tx, l.variant_id);
  }
  if (action === 'close' && !lines.some((l) => decimal(l.outstanding).gt(0)))
    throw conflict('No unreceived quantity remains.');
  const status = {
    submit: 'submitted',
    approve: 'approved',
    reject: 'rejected',
    cancel: 'cancelled',
    close: 'closed',
  }[action] as Action;
  if (action === 'approve')
    await requireEligibleAuthor(
      tx,
      branchId,
      order.actor_id,
      'purchasing.manage',
    );
  await tx.query(
    'UPDATE purchase_orders SET status=$2,version=version+1,approver_id=CASE WHEN $2=$5 THEN $3 ELSE approver_id END,close_reason=CASE WHEN $2 IN ($6,$7,$8) THEN $4 ELSE close_reason END WHERE id=$1',
    [
      id,
      status,
      actorId,
      reason,
      'approved',
      'closed',
      'rejected',
      'cancelled',
    ],
  );
  await purchaseEvent(
    tx,
    branchId,
    actorId,
    id,
    version + 1,
    'order',
    status,
    reason,
  );
  return { id, version: version + 1, status };
}
export async function saveReceipt(
  tx: Transaction,
  branchId: string,
  actorId: string,
  input: unknown,
  edit?: { id: string; version: number },
) {
  const data = purchaseReceiptInput.parse(input);
  const id = edit?.id ?? randomUUID();
  // Lock order first, then receipt, then complete inventory scope everywhere.
  const { order, lines } = await orderDetail(tx, branchId, data.orderId, true);
  if (!['approved', 'partially_received'].includes(order.status))
    throw conflict('Receipts require an approved, open order.');
  if (edit) {
    const old = (await receiptDetail(tx, branchId, id, true)).receipt;
    requireDraft(old, edit.version, actorId);
    if (old.order_id !== data.orderId || old.kind !== 'receipt')
      throw conflict('Receipt order and kind cannot change.');
  }
  await activeSupplier(tx, branchId, order.supplier_id);
  const items = [];
  for (const line of data.lines) {
    const source = requireFound(lines.find((l) => l.id === line.orderItemId));
    await activeVariant(tx, source.variant_id);
    if (decimal(line.quantity).gt(source.outstanding))
      throw conflict(
        'Receipt exceeds the remaining approved order quantity. Excess deliveries require a separately approved order.',
      );
    const quantity = converted(
      line.quantity,
      source.conversion,
      source.snapshot.fractional,
    );
    items.push({
      source,
      line,
      baseQuantity: quantity,
      ...receiptAmounts(source, source.received, line.quantity),
    });
  }
  const version = (edit?.version ?? 0) + 1;
  if (edit) {
    await tx.query('DELETE FROM purchase_items WHERE purchase_id=$1', [id]);
    await tx.query(
      'UPDATE purchases SET supplier_reference=$2,delivery_reference=$3,note=$4,version=$5 WHERE id=$1',
      [id, data.supplierReference, data.deliveryReference, data.note, version],
    );
  } else
    await tx.query(
      "INSERT INTO purchases(id,branch_id,installation_id,order_id,supplier_id,kind,actor_id,supplier_reference,delivery_reference,note,snapshot) VALUES($1,$2,$3,$4,$5,'receipt',$6,$7,$8,$9,$10)",
      [
        id,
        branchId,
        order.installation_id,
        order.id,
        order.supplier_id,
        actorId,
        data.supplierReference,
        data.deliveryReference,
        data.note,
        JSON.stringify({ ...order.snapshot, orderNumber: order.number }),
      ],
    );
  for (const i of items)
    await tx.query(
      'INSERT INTO purchase_items(id,purchase_id,order_item_id,variant_id,condition,quantity,base_quantity,net,tax,total,discount,stock_value,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        randomUUID(),
        id,
        i.source.id,
        i.source.variant_id,
        i.line.condition,
        i.line.quantity,
        i.baseQuantity,
        i.net,
        i.tax,
        i.total,
        i.discount,
        i.stock_value,
        JSON.stringify({
          ...i.source.snapshot,
          unitCost: i.source.unit_cost,
          discountRate: i.source.discount_rate,
          taxRate: i.source.tax_rate,
          taxInclusive: i.source.tax_inclusive,
          capitalizeTax: i.source.capitalize_tax,
          receivedBefore: i.source.received,
        }),
      ],
    );
  await purchaseEvent(
    tx,
    branchId,
    actorId,
    id,
    version,
    'receipt',
    edit ? 'edited' : 'drafted',
  );
  return { id, version };
}
export async function createReversal(
  tx: Transaction,
  branchId: string,
  actorId: string,
  originalId: string,
  reason: string,
) {
  const initial = await receiptDetail(tx, branchId, originalId);
  await orderDetail(tx, branchId, initial.receipt.order_id, true);
  const { receipt: original, items } = await receiptDetail(
    tx,
    branchId,
    originalId,
    true,
  );
  if (original.kind !== 'receipt' || original.status !== 'posted')
    throw conflict('Only a posted receipt can be reversed.');
  if (
    (
      await tx.query(
        "SELECT 1 FROM purchases WHERE original_id=$1 AND status='posted'",
        [originalId],
      )
    ).rowCount
  )
    throw conflict('Receipt was already reversed.');
  const id = randomUUID();
  await tx.query(
    "INSERT INTO purchases(id,branch_id,installation_id,order_id,supplier_id,kind,actor_id,original_id,supplier_reference,delivery_reference,note,snapshot) SELECT $1,branch_id,installation_id,order_id,supplier_id,'reversal',$2,id,supplier_reference,delivery_reference,$3,snapshot FROM purchases WHERE id=$4",
    [id, actorId, reason, originalId],
  );
  for (const item of items)
    await tx.query(
      'INSERT INTO purchase_items(id,purchase_id,order_item_id,variant_id,condition,quantity,base_quantity,net,tax,total,discount,stock_value,balance_version,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [
        randomUUID(),
        id,
        item.order_item_id,
        item.variant_id,
        item.condition,
        item.quantity,
        item.base_quantity,
        decimal(item.net).negated().toFixed(2),
        decimal(item.tax).negated().toFixed(2),
        decimal(item.total).negated().toFixed(2),
        decimal(item.discount).negated().toFixed(2),
        decimal(item.stock_value).negated().toFixed(6),
        item.balance_version,
        JSON.stringify(item.snapshot),
      ],
    );
  await purchaseEvent(tx, branchId, actorId, id, 1, 'reversal', 'drafted');
  return { id, version: 1 };
}
export async function postReceipt(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
  version: number,
  approveReversal = false,
) {
  const initial = await receiptDetail(tx, branchId, id);
  const { order, lines } = await orderDetail(
    tx,
    branchId,
    initial.receipt.order_id,
    true,
  );
  const { receipt, items } = await receiptDetail(tx, branchId, id, true);
  if (receipt.status !== 'draft' || receipt.version !== version)
    throw conflict('Receipt changed or was finalized. Reload it.');
  if (receipt.kind === 'receipt') {
    if (approveReversal)
      throw conflict('Use normal posting for a goods receipt.');
    requireDraft(receipt, version, actorId);
    if (!['approved', 'partially_received'].includes(order.status))
      throw conflict('The order is no longer open for receiving.');
    await activeSupplier(tx, branchId, receipt.supplier_id);
  } else {
    if (!approveReversal || receipt.actor_id === actorId)
      throw new HttpError(
        403,
        'SELF_APPROVAL',
        'A different authorized reviewer must approve a receipt reversal.',
      );
    await requireEligibleAuthor(
      tx,
      branchId,
      receipt.actor_id,
      'purchasing.receive',
    );
    if (
      (
        await tx.query(
          "SELECT 1 FROM purchases WHERE original_id=$1 AND status='posted'",
          [receipt.original_id],
        )
      ).rowCount
    )
      throw conflict('This receipt was already reversed.');
  }
  await lockInventory(
    tx,
    branchId,
    items.map((i) => i.variant_id),
  );
  const sums = {
    net: decimal('0'),
    tax: decimal('0'),
    total: decimal('0'),
    stock_value: decimal('0'),
  };
  for (const item of items) {
    if (receipt.kind === 'receipt') {
      const source = requireFound(
        lines.find((l) => l.id === item.order_item_id),
      );
      if (decimal(item.quantity).gt(source.outstanding))
        throw conflict('Delivery exceeds the remaining approved quantity.');
      const calculated = receiptAmounts(source, source.received, item.quantity);
      if (
        !['net', 'tax', 'total', 'discount', 'stock_value'].every((k) =>
          decimal(item[k as keyof typeof calculated]).eq(
            calculated[k as keyof typeof calculated],
          ),
        )
      )
        throw conflict(
          'Earlier receiving changed this draft allocation. Edit and save the draft before posting.',
        );
    } else {
      const source = requireFound(
        lines.find((l) => l.id === item.order_item_id),
      );
      if (
        !decimal(source.received).eq(
          decimal(item.snapshot.receivedBefore).plus(item.quantity),
        )
      )
        throw conflict(
          'Later receiving remains on this order line. Reverse those receipts first to preserve cumulative rounding allocations.',
        );
      const latest = (
        await tx.query<{ version: number }>(
          'SELECT max(balance_version) version FROM inventory_movements WHERE branch_id=$1 AND variant_id=$2 AND condition=$3',
          [branchId, item.variant_id, item.condition],
        )
      ).rows[0];
      if (!latest || latest.version !== item.balance_version)
        throw conflict(
          'Stock has moved since this receipt. Automatic reversal is blocked; retain the original and investigate a reviewed stock correction.',
        );
    }
    await applyMovement(tx, {
      installationId: receipt.installation_id,
      branchId,
      variantId: item.variant_id,
      condition: item.condition,
      quantity:
        receipt.kind === 'receipt'
          ? item.base_quantity
          : decimal(item.base_quantity).negated().toFixed(6),
      unitCost: '0',
      valueChange: item.stock_value,
      sourceType: 'purchase',
      sourceId: id,
      sourceLineId: item.id,
      actorId,
    });
    if (receipt.kind === 'receipt')
      await tx.query(
        'UPDATE purchase_items SET balance_version=$2 WHERE id=$1',
        [
          item.id,
          (await balance(tx, branchId, item.variant_id, item.condition))
            .version,
        ],
      );
    for (const key of Object.keys(sums) as (keyof typeof sums)[])
      sums[key] = sums[key].plus(item[key]);
  }
  const series = receipt.kind === 'receipt' ? 'GR' : 'GRV';
  const number = `${series}-${await allocateDocumentNumber(tx, { documentId: id, branchId, installationId: receipt.installation_id, series })}`;
  await tx.query(
    "UPDATE purchases SET status='posted',version=version+1,number=$2,posted_at=now(),net=$3,tax=$4,total=$5,stock_value=$6,approver_id=$7 WHERE id=$1",
    [
      id,
      number,
      sums.net.toFixed(2),
      sums.tax.toFixed(2),
      sums.total.toFixed(2),
      sums.stock_value.toFixed(6),
      receipt.kind === 'reversal' ? actorId : null,
    ],
  );
  const updated = await orderDetail(tx, branchId, order.id);
  if (order.status !== 'closed') {
    const status = updated.lines.every((l) => decimal(l.outstanding).isZero())
      ? 'received'
      : updated.lines.some((l) => decimal(l.received).gt(0))
        ? 'partially_received'
        : 'approved';
    await tx.query(
      'UPDATE purchase_orders SET status=$2,version=version+1 WHERE id=$1',
      [order.id, status],
    );
    await purchaseEvent(
      tx,
      branchId,
      actorId,
      order.id,
      order.version + 1,
      'order',
      'received',
      `${receipt.kind}: ${number}`,
    );
  }
  await purchaseEvent(
    tx,
    branchId,
    actorId,
    id,
    version + 1,
    receipt.kind,
    'posted',
  );
  return { id, number, version: version + 1 };
}
export async function cancelReceipt(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
  version: number,
) {
  const initial = await receiptDetail(tx, branchId, id);
  await orderDetail(tx, branchId, initial.receipt.order_id, true);
  const { receipt } = await receiptDetail(tx, branchId, id, true);
  requireDraft(receipt, version, actorId);
  await tx.query(
    "UPDATE purchases SET status='cancelled',version=version+1 WHERE id=$1",
    [id],
  );
  await purchaseEvent(
    tx,
    branchId,
    actorId,
    id,
    version + 1,
    receipt.kind,
    'cancelled',
  );
  return { id, version: version + 1 };
}
