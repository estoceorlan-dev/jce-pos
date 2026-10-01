import { randomUUID } from 'node:crypto';
import {
  type TransferInput,
  type TransferReceiptInput,
  type TransferDiscrepancyInput,
  type StockCondition,
} from '@jce/shared';
import type { Transaction } from '../db/transaction.js';
import { decimal } from '../db/decimal.js';
import { checksum } from '../db/canonical.js';
import { allocateDocumentNumber } from '../db/numbering.js';
import { appendAudit } from '../audit/append.js';
import { appendOutbox } from '../sync/outbox.js';
import { HttpError, requireFound } from '../management/common.js';
import {
  applyMovement,
  assertReconciled,
  balance,
  conflict,
  installation,
  lockInventory,
} from '../inventory/ledger.js';
import { eligible } from '../checkout/service.js';
import { returnShare } from '../reconciliation/calculations.js';

export type Transfer = {
  id: string;
  installation_id: string;
  source_branch_id: string;
  destination_branch_id: string;
  actor_id: string;
  approver_id: string | null;
  return_of_id: string | null;
  number: string;
  version: number;
  status: string;
  note: string;
  snapshot: Record<string, unknown>;
};
type Snapshot = {
  sku: string;
  name: string;
  unit: string;
  conversion: string;
  fractional: boolean;
  archived: boolean;
};
type Item = {
  id: string;
  transfer_id: string;
  variant_id: string;
  quantity: string;
  snapshot: Snapshot;
};
type Transit = {
  transfer_item_id: string;
  transit_quantity: string;
  transit_value: string;
  shipped_quantity: string;
  shipped_value: string;
  received_quantity: string;
  received_value: string;
  lost_quantity: string;
  lost_value: string;
  returned_quantity: string;
  returned_value: string;
  matched: boolean;
};
export const productQuery = `SELECT v.id,v.sku,p.name||' / '||v.name name,u.name unit,v.conversion,v.fractional,(v.archived OR p.archived OR u.archived) archived FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id`;
export async function getTransfer(
  tx: Transaction,
  branch: string,
  id: string,
  lock = false,
) {
  return requireFound(
    (
      await tx.query<Transfer>(
        `SELECT * FROM stock_transfers WHERE id=$1 AND (source_branch_id=$2 OR destination_branch_id=$2)${lock ? ' FOR UPDATE' : ''}`,
        [id, branch],
      )
    ).rows[0],
  );
}
export function side(
  t: Transfer,
  branch: string,
  where: 'source' | 'destination',
) {
  if (
    t[where === 'source' ? 'source_branch_id' : 'destination_branch_id'] !==
    branch
  )
    throw new HttpError(
      403,
      'TRANSFER_SIDE_REQUIRED',
      `This action requires the ${where} branch.`,
    );
}
function unchanged(t: Transfer, version: number, statuses: string[]) {
  if (t.version !== version || !statuses.includes(t.status))
    throw conflict(
      'Transfer changed or cannot make that transition. Reload its current version.',
    );
}
function quantity(q: string, snapshot: Snapshot) {
  if (decimal(q).lte(0) || (!snapshot.fractional && !decimal(q).isInteger()))
    throw conflict(
      'Use a positive base-unit quantity consistent with the product fraction policy.',
    );
}
async function localPair(tx: Transaction, source: string, destination: string) {
  const a = await installation(tx, source),
    b = await installation(tx, destination);
  if (a !== b || source === destination)
    throw conflict(
      'Choose different branches owned by this local installation. Independent-installation transfers are unavailable.',
    );
  return a;
}
export async function items(tx: Transaction, id: string) {
  return (
    await tx.query<Item>(
      'SELECT * FROM stock_transfer_items WHERE transfer_id=$1 ORDER BY variant_id',
      [id],
    )
  ).rows;
}
export async function conservation(tx: Pick<Transaction, 'query'>, id: string) {
  return (
    await tx.query<Transit>(
      'SELECT * FROM transfer_conservation WHERE transfer_id=$1 ORDER BY transfer_item_id',
      [id],
    )
  ).rows;
}
async function assertConserved(tx: Transaction, id: string) {
  const rows = await conservation(tx, id);
  if (!rows.length || rows.some((r) => !r.matched))
    throw conflict(
      'Transfer quantity/value mismatch. Review the transfer ledger before continuing.',
    );
  return rows;
}
type TransferEventAction =
  | 'drafted'
  | 'edited'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'dispatched'
  | 'received'
  | 'discrepancy_requested'
  | 'resolved';
export async function transferEvent(
  tx: Transaction,
  t: Transfer,
  branch: string,
  actor: string,
  action: TransferEventAction,
  note: string,
  documentId: string | null = null,
) {
  await tx.query(
    'INSERT INTO transfer_events(id,transfer_id,version,actor_id,action,note,document_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), t.id, t.version, actor, action, note, documentId],
  );
  await appendAudit(tx, {
    installationId: t.installation_id,
    branchId: branch,
    actorId: actor,
    requestId: randomUUID(),
    action: `transfers.${action}`,
    entityType: 'stock_transfer',
    entityId: t.id,
    entityVersion: t.version,
  });
  await appendOutbox(
    tx,
    {
      installationId: t.installation_id,
      branchId: branch,
      aggregateId: t.id,
      aggregateVersion: t.version,
    },
    {
      eventType: 'transfers.changed',
      aggregateType: 'transfer',
      payload: { entityId: t.id, action, documentId },
    },
  );
}
async function advance(
  tx: Transaction,
  t: Transfer,
  status: string,
  branch: string,
  actor: string,
  action: TransferEventAction,
  note: string,
  documentId: string | null = null,
  approver: string | null = t.approver_id,
) {
  await tx.query(
    'UPDATE stock_transfers SET status=$2,version=version+1,approver_id=$3,updated_at=now() WHERE id=$1',
    [t.id, status, approver],
  );
  t = { ...t, status, version: t.version + 1, approver_id: approver };
  await transferEvent(tx, t, branch, actor, action, note, documentId);
  return t;
}
async function returnEligibility(
  tx: Transaction,
  source: string,
  destination: string,
  returnOfId: string | null,
  lines: { variantId: string; quantity: string }[],
  excludeId: string | null = null,
) {
  if (!returnOfId) return null;
  const original = await getTransfer(tx, source, returnOfId, true);
  if (
    original.return_of_id ||
    original.destination_branch_id !== source ||
    original.source_branch_id !== destination ||
    !['in_transit', 'partially_received', 'received'].includes(original.status)
  )
    throw conflict(
      'A return transfer must reverse the branches of an original dispatched transfer.',
    );
  for (const l of lines) {
    const available = (
      await tx.query<{ quantity: string }>(
        `SELECT (COALESCE((SELECT sum(r.quantity) FROM transfer_receipt_items r JOIN stock_transfer_items i ON i.id=r.transfer_item_id WHERE i.transfer_id=$1 AND i.variant_id=$2 AND r.condition='sellable'),0)-COALESCE((SELECT sum(i.quantity) FROM stock_transfer_items i JOIN stock_transfers t ON t.id=i.transfer_id WHERE t.return_of_id=$1 AND i.variant_id=$2 AND t.status IN ('approved','in_transit','partially_received','received') AND ($3::uuid IS NULL OR t.id<>$3)),0))::text quantity`,
        [returnOfId, l.variantId, excludeId],
      )
    ).rows[0]!;
    if (decimal(l.quantity).gt(available.quantity))
      throw conflict(
        'The return transfer exceeds the original sellable receipts remaining for return.',
      );
  }
  return original.number;
}
export async function saveTransfer(
  tx: Transaction,
  branch: string,
  actor: string,
  d: TransferInput,
  edit?: { id: string; version: number },
) {
  let old: Transfer | undefined;
  if (edit) {
    old = await getTransfer(tx, branch, edit.id, true);
    side(old, branch, 'source');
    unchanged(old, edit.version, ['draft']);
    if (old.actor_id !== actor)
      throw new HttpError(
        403,
        'AUTHOR_REQUIRED',
        'Only the draft author can edit this transfer.',
      );
    if (
      old.destination_branch_id !== d.destinationBranchId ||
      old.return_of_id !== d.returnOfId
    )
      throw conflict(
        'Transfer branches and original link cannot change; cancel and create a new draft.',
      );
  }
  const installationId = await localPair(tx, branch, d.destinationBranchId);
  const branches = (
    await tx.query<{ id: string; name: string; code: string }>(
      'SELECT id,name,code FROM branches WHERE id=ANY($1::uuid[]) AND archived_at IS NULL ORDER BY id',
      [[branch, d.destinationBranchId]],
    )
  ).rows;
  if (branches.length !== 2) throw conflict('Both branches must be active.');
  const returnOfNumber = await returnEligibility(
    tx,
    branch,
    d.destinationBranchId,
    d.returnOfId,
    d.lines,
    old?.id,
  );
  const snapshots: Snapshot[] = [];
  for (const l of d.lines) {
    const v = requireFound(
      (await tx.query<Snapshot>(`${productQuery} WHERE v.id=$1`, [l.variantId]))
        .rows[0],
    );
    if (v.archived)
      throw conflict('Archived products cannot start a transfer.');
    quantity(l.quantity, v);
    snapshots.push(v);
  }
  const id = old?.id ?? randomUUID(),
    number =
      old?.number ??
      `TRN-${await allocateDocumentNumber(tx, { documentId: id, installationId, branchId: branch, series: 'TRN' })}`;
  const snapshot = {
    source: branches.find((b) => b.id === branch)!,
    destination: branches.find((b) => b.id === d.destinationBranchId)!,
    returnOfNumber,
  };
  if (old) {
    await tx.query(
      'UPDATE stock_transfers SET note=$2,snapshot=$3,version=version+1,updated_at=now() WHERE id=$1',
      [id, d.note, JSON.stringify(snapshot)],
    );
    await tx.query('DELETE FROM stock_transfer_items WHERE transfer_id=$1', [
      id,
    ]);
  } else
    await tx.query(
      'INSERT INTO stock_transfers(id,installation_id,source_branch_id,destination_branch_id,actor_id,return_of_id,number,note,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        id,
        installationId,
        branch,
        d.destinationBranchId,
        actor,
        d.returnOfId,
        number,
        d.note,
        JSON.stringify(snapshot),
      ],
    );
  for (const [index, l] of d.lines.entries())
    await tx.query(
      'INSERT INTO stock_transfer_items(id,transfer_id,variant_id,quantity,snapshot) VALUES($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        id,
        l.variantId,
        l.quantity,
        JSON.stringify(snapshots[index]),
      ],
    );
  const t = await getTransfer(tx, branch, id);
  await transferEvent(tx, t, branch, actor, old ? 'edited' : 'drafted', d.note);
  return { id, version: t.version, number };
}
async function reserve(
  tx: Transaction,
  t: Transfer,
  lines: Item[],
  actor: string,
) {
  await lockInventory(
    tx,
    t.source_branch_id,
    lines.map((l) => l.variant_id),
  );
  for (const l of lines) {
    const v = requireFound(
      (
        await tx.query<Snapshot>(`${productQuery} WHERE v.id=$1`, [
          l.variant_id,
        ])
      ).rows[0],
    );
    if (v.archived)
      throw conflict('Review archived products before approving.');
    quantity(l.quantity, v);
    if (
      v.unit !== l.snapshot.unit ||
      v.conversion !== l.snapshot.conversion ||
      v.fractional !== l.snapshot.fractional
    )
      throw conflict(
        'Product units changed after drafting. Create a new transfer with the current units.',
      );
    const current = await assertReconciled(
      tx,
      t.source_branch_id,
      l.variant_id,
      'sellable',
    );
    if (decimal(current.quantity).minus(current.reserved).lt(l.quantity))
      throw conflict('Insufficient available source stock for this transfer.');
    const id = randomUUID();
    await tx.query(
      'INSERT INTO inventory_reservations(id,installation_id,branch_id,variant_id,quantity,reference,actor_id,transfer_item_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        t.installation_id,
        t.source_branch_id,
        l.variant_id,
        l.quantity,
        t.number,
        actor,
        l.id,
      ],
    );
    await tx.query(
      "UPDATE inventories SET reserved=reserved+$3,version=version+1 WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
      [t.source_branch_id, l.variant_id, l.quantity],
    );
    await tx.query(
      "INSERT INTO inventory_reservation_events(id,reservation_id,action,actor_id) VALUES($1,$2,'allocated',$3)",
      [randomUUID(), id, actor],
    );
  }
}
async function release(
  tx: Transaction,
  t: Transfer,
  lines: Item[],
  actor: string,
) {
  await lockInventory(
    tx,
    t.source_branch_id,
    lines.map((l) => l.variant_id),
  );
  for (const l of lines) {
    await assertReconciled(tx, t.source_branch_id, l.variant_id, 'sellable');
    const r = requireFound(
      (
        await tx.query<{ id: string; status: string; quantity: string }>(
          'SELECT id,status,quantity FROM inventory_reservations WHERE transfer_item_id=$1 FOR UPDATE',
          [l.id],
        )
      ).rows[0],
    );
    if (r.status !== 'active' || !decimal(r.quantity).eq(l.quantity))
      throw conflict('Transfer reservation is not intact.');
    await tx.query(
      "UPDATE inventory_reservations SET status='released',released_at=now() WHERE id=$1",
      [r.id],
    );
    await tx.query(
      "UPDATE inventories SET reserved=reserved-$3,version=version+1 WHERE branch_id=$1 AND variant_id=$2 AND condition='sellable'",
      [t.source_branch_id, l.variant_id, l.quantity],
    );
    await tx.query(
      "INSERT INTO inventory_reservation_events(id,reservation_id,action,actor_id) VALUES($1,$2,'released',$3)",
      [randomUUID(), r.id, actor],
    );
  }
}
async function transitEntry(
  tx: Transaction,
  itemId: string,
  actor: string,
  kind: string,
  sourceId: string,
  lineId: string,
  q: string,
  value: string,
) {
  await tx.query(
    'INSERT INTO transfer_transit_entries(id,transfer_item_id,kind,source_id,source_line_id,actor_id,quantity,value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), itemId, kind, sourceId, lineId, actor, q, value],
  );
}
export async function transition(
  tx: Transaction,
  branch: string,
  actor: string,
  id: string,
  version: number,
  action: 'submit' | 'approve' | 'reject' | 'cancel' | 'dispatch',
  note: string,
) {
  let t = await getTransfer(tx, branch, id, true);
  side(t, branch, 'source');
  await localPair(tx, t.source_branch_id, t.destination_branch_id);
  const lines = await items(tx, id);
  if (action === 'submit') {
    unchanged(t, version, ['draft']);
    if (t.actor_id !== actor)
      throw new HttpError(
        403,
        'AUTHOR_REQUIRED',
        'Only the author can submit this transfer.',
      );
    t = await advance(tx, t, 'pending', branch, actor, 'submitted', note);
  } else if (action === 'approve' || action === 'reject') {
    unchanged(t, version, ['pending']);
    if (t.actor_id === actor)
      throw new HttpError(
        403,
        'SELF_APPROVAL',
        'A different source-branch reviewer must approve or reject this transfer.',
      );
    await eligible(tx, branch, t.actor_id, 'transfers.manage');
    if (action === 'approve') {
      await returnEligibility(
        tx,
        branch,
        t.destination_branch_id,
        t.return_of_id,
        lines.map((l) => ({ variantId: l.variant_id, quantity: l.quantity })),
        id,
      );
      await reserve(tx, t, lines, actor);
    }
    t = await advance(
      tx,
      t,
      action === 'approve' ? 'approved' : 'rejected',
      branch,
      actor,
      action === 'approve' ? 'approved' : 'rejected',
      note,
      null,
      action === 'approve' ? actor : null,
    );
  } else if (action === 'cancel') {
    unchanged(t, version, ['draft', 'pending', 'approved']);
    if (t.actor_id !== actor)
      throw new HttpError(
        403,
        'AUTHOR_REQUIRED',
        'Only the author can cancel a transfer before shipment.',
      );
    if (t.status === 'approved') await release(tx, t, lines, actor);
    t = await advance(tx, t, 'cancelled', branch, actor, 'cancelled', note);
  } else {
    unchanged(t, version, ['approved']);
    await release(tx, t, lines, actor);
    await tx.query(
      'INSERT INTO transfer_shipments(transfer_id,actor_id,note) VALUES($1,$2,$3)',
      [id, actor, note],
    );
    for (const l of lines) {
      const before = await balance(tx, branch, l.variant_id, 'sellable');
      await applyMovement(tx, {
        installationId: t.installation_id,
        branchId: branch,
        variantId: l.variant_id,
        condition: 'sellable',
        quantity: decimal(l.quantity).negated().toFixed(6),
        unitCost: '0',
        sourceType: 'transfer_dispatch',
        sourceId: id,
        sourceLineId: l.id,
        actorId: actor,
      });
      const after = await balance(tx, branch, l.variant_id, 'sellable'),
        value = decimal(before.value).minus(after.value).toFixed(6);
      await tx.query(
        'INSERT INTO transfer_shipment_items(transfer_item_id,transfer_id,quantity,value) VALUES($1,$2,$3,$4)',
        [l.id, id, l.quantity, value],
      );
      await transitEntry(
        tx,
        l.id,
        actor,
        'dispatch',
        id,
        l.id,
        l.quantity,
        value,
      );
    }
    await assertConserved(tx, id);
    t = await advance(tx, t, 'in_transit', branch, actor, 'dispatched', note);
  }
  return { id, version: t.version };
}
type Allocation = {
  transferItemId: string;
  variantId: string;
  quantity: string;
  value: string;
  condition: StockCondition;
  name: string;
  prior: string;
};
async function allocations(
  tx: Transaction,
  t: Transfer,
  requested: {
    transferItemId: string;
    quantity: string;
    condition: StockCondition;
  }[],
) {
  const transit = await assertConserved(tx, t.id),
    source = await items(tx, t.id),
    result: Allocation[] = [];
  for (const r of requested) {
    const l = requireFound(source.find((i) => i.id === r.transferItemId)),
      b = requireFound(transit.find((i) => i.transfer_item_id === l.id));
    quantity(r.quantity, l.snapshot);
    if (decimal(r.quantity).gt(b.transit_quantity))
      throw conflict(
        'The receipt or resolution exceeds remaining dispatched stock.',
      );
    const prior = decimal(b.shipped_quantity)
      .minus(b.transit_quantity)
      .toFixed(6);
    result.push({
      ...r,
      quantity: decimal(r.quantity).toFixed(6),
      variantId: l.variant_id,
      name: l.snapshot.name,
      prior,
      value: returnShare(
        b.shipped_value,
        b.shipped_quantity,
        prior,
        r.quantity,
        6,
      ),
    });
  }
  return result;
}
async function finishTransit(
  tx: Transaction,
  t: Transfer,
  branch: string,
  actor: string,
  action: 'received' | 'resolved',
  note: string,
  docId: string,
) {
  const rows = await assertConserved(tx, t.id);
  const status = rows.every((r) => decimal(r.transit_quantity).isZero())
    ? 'received'
    : 'partially_received';
  return advance(tx, t, status, branch, actor, action, note, docId);
}
export async function receive(
  tx: Transaction,
  branch: string,
  actor: string,
  id: string,
  d: TransferReceiptInput,
) {
  const t = await getTransfer(tx, branch, id, true);
  side(t, branch, 'destination');
  unchanged(t, d.version, ['in_transit', 'partially_received']);
  await localPair(tx, t.source_branch_id, t.destination_branch_id);
  const lines = await allocations(tx, t, d.lines),
    receiptId = randomUUID(),
    number = `TRC-${await allocateDocumentNumber(tx, { documentId: receiptId, installationId: t.installation_id, branchId: branch, series: 'TRC' })}`;
  await lockInventory(
    tx,
    branch,
    lines.map((l) => l.variantId),
  );
  await tx.query(
    'INSERT INTO transfer_receipts(id,transfer_id,actor_id,number,note) VALUES($1,$2,$3,$4,$5)',
    [receiptId, id, actor, number, d.note],
  );
  for (const l of lines) {
    const lineId = randomUUID();
    await tx.query(
      'INSERT INTO transfer_receipt_items(id,receipt_id,transfer_id,transfer_item_id,quantity,value,condition) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        lineId,
        receiptId,
        id,
        l.transferItemId,
        l.quantity,
        l.value,
        l.condition,
      ],
    );
    await applyMovement(tx, {
      installationId: t.installation_id,
      branchId: branch,
      variantId: l.variantId,
      condition: l.condition,
      quantity: l.quantity,
      unitCost: '0',
      valueChange: l.value,
      dispatchedTransfer: true,
      sourceType: 'transfer_receipt',
      sourceId: receiptId,
      sourceLineId: lineId,
      actorId: actor,
    });
    await transitEntry(
      tx,
      l.transferItemId,
      actor,
      'receipt',
      receiptId,
      lineId,
      decimal(l.quantity).negated().toFixed(6),
      decimal(l.value).negated().toFixed(6),
    );
  }
  await tx.query("UPDATE transfer_receipts SET status='posted' WHERE id=$1", [
    receiptId,
  ]);
  const updated = await finishTransit(
    tx,
    t,
    branch,
    actor,
    'received',
    d.note,
    receiptId,
  );
  return { id: receiptId, transferId: id, version: updated.version, number };
}
export async function proposeDiscrepancy(
  tx: Transaction,
  branch: string,
  actor: string,
  id: string,
  d: TransferDiscrepancyInput,
) {
  let t = await getTransfer(tx, branch, id, true);
  side(t, branch, 'destination');
  unchanged(t, d.version, ['in_transit', 'partially_received']);
  const quote = await allocations(tx, t, d.lines),
    requestId = randomUUID();
  t = await advance(
    tx,
    t,
    t.status,
    branch,
    actor,
    'discrepancy_requested',
    d.note,
    requestId,
  );
  const input = {
    version: d.version,
    note: d.note,
    reasonCode: d.reasonCode,
    lines: d.lines,
  };
  await tx.query(
    'INSERT INTO transfer_discrepancies(id,transfer_id,actor_id,transfer_version,reason_code,note,input,quote) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      requestId,
      id,
      actor,
      t.version,
      d.reasonCode,
      d.note,
      JSON.stringify(input),
      JSON.stringify(quote),
    ],
  );
  return { id: requestId, transferId: id, version: t.version };
}
export async function resolveDiscrepancy(
  tx: Transaction,
  branch: string,
  actor: string,
  id: string,
  requestId: string,
  version: number,
) {
  const t = await getTransfer(tx, branch, id, true);
  side(t, branch, 'destination');
  unchanged(t, version, ['in_transit', 'partially_received']);
  const d = requireFound(
    (
      await tx.query<{
        actor_id: string;
        status: string;
        transfer_version: number;
        input: Omit<TransferDiscrepancyInput, 'requestKey'>;
        quote: Allocation[];
        note: string;
      }>(
        'SELECT * FROM transfer_discrepancies WHERE id=$1 AND transfer_id=$2 FOR UPDATE',
        [requestId, id],
      )
    ).rows[0],
  );
  if (d.status !== 'pending' || d.transfer_version !== version)
    throw conflict(
      'This proposal is stale or already resolved. Review a new proposal against current transit stock.',
    );
  if (d.actor_id === actor)
    throw new HttpError(
      403,
      'SELF_APPROVAL',
      'A different destination reviewer must resolve this discrepancy.',
    );
  await eligible(tx, branch, d.actor_id, 'transfers.receive');
  const lines = await allocations(tx, t, d.input.lines);
  const allocationHash = (values: Allocation[]) =>
    checksum(
      values.map((l) => ({
        transferItemId: l.transferItemId,
        variantId: l.variantId,
        quantity: l.quantity,
        value: l.value,
        condition: l.condition,
        prior: l.prior,
      })),
    );
  if (allocationHash(lines) !== allocationHash(d.quote))
    throw conflict('The exact proposed quantities and values changed.');
  const returning = d.input.lines.filter(
    (l) => l.resolution === 'return_to_source',
  );
  if (returning.length) {
    await eligible(tx, t.source_branch_id, actor, 'transfers.resolve');
    await lockInventory(
      tx,
      t.source_branch_id,
      lines
        .filter((l) =>
          returning.some((r) => r.transferItemId === l.transferItemId),
        )
        .map((l) => l.variantId),
    );
  }
  for (const l of lines) {
    const requested = d.input.lines.find(
        (r) => r.transferItemId === l.transferItemId,
      )!,
      lineId = randomUUID();
    await tx.query(
      'INSERT INTO transfer_discrepancy_items(id,discrepancy_id,transfer_id,transfer_item_id,quantity,value,resolution,condition) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        lineId,
        requestId,
        id,
        l.transferItemId,
        l.quantity,
        l.value,
        requested.resolution,
        l.condition,
      ],
    );
    if (requested.resolution === 'return_to_source')
      await applyMovement(tx, {
        installationId: t.installation_id,
        branchId: t.source_branch_id,
        variantId: l.variantId,
        condition: l.condition,
        quantity: l.quantity,
        unitCost: '0',
        valueChange: l.value,
        dispatchedTransfer: true,
        sourceType: 'transfer_return',
        sourceId: requestId,
        sourceLineId: lineId,
        actorId: actor,
      });
    await transitEntry(
      tx,
      l.transferItemId,
      actor,
      requested.resolution,
      requestId,
      lineId,
      decimal(l.quantity).negated().toFixed(6),
      decimal(l.value).negated().toFixed(6),
    );
  }
  await tx.query(
    "UPDATE transfer_discrepancies SET status='posted',approver_id=$2,posted_at=now() WHERE id=$1",
    [requestId, actor],
  );
  const updated = await finishTransit(
    tx,
    t,
    branch,
    actor,
    'resolved',
    d.note,
    requestId,
  );
  return { id: requestId, transferId: id, version: updated.version };
}
export async function detail(tx: Transaction, branch: string, id: string) {
  // Root lock keeps this multi-query document and its ledger on one version.
  const transfer = await getTransfer(tx, branch, id, true),
    lines = await items(tx, id),
    ledger = await conservation(tx, id);
  const receipts = (
    await tx.query(
      'SELECT r.*,u.display_name actor FROM transfer_receipts r JOIN users u ON u.id=r.actor_id WHERE r.transfer_id=$1 ORDER BY r.posted_at,r.id',
      [id],
    )
  ).rows;
  const receiptItems = (
    await tx.query(
      'SELECT * FROM transfer_receipt_items WHERE transfer_id=$1 ORDER BY receipt_id,id',
      [id],
    )
  ).rows;
  const discrepancies = (
    await tx.query(
      'SELECT d.*,u.display_name actor,a.display_name approver FROM transfer_discrepancies d JOIN users u ON u.id=d.actor_id LEFT JOIN users a ON a.id=d.approver_id WHERE d.transfer_id=$1 ORDER BY d.created_at,d.id',
      [id],
    )
  ).rows;
  const events = (
    await tx.query(
      'SELECT e.*,u.display_name actor FROM transfer_events e JOIN users u ON u.id=e.actor_id WHERE e.transfer_id=$1 ORDER BY e.version',
      [id],
    )
  ).rows;
  const shipment =
    (
      await tx.query(
        'SELECT s.*,u.display_name actor FROM transfer_shipments s JOIN users u ON u.id=s.actor_id WHERE s.transfer_id=$1',
        [id],
      )
    ).rows[0] ?? null;
  const returns = (
    await tx.query(
      'SELECT id,number,status FROM stock_transfers WHERE return_of_id=$1 ORDER BY created_at,id',
      [id],
    )
  ).rows;
  return {
    transfer,
    lines,
    ledger,
    receipts,
    receiptItems,
    discrepancies,
    events,
    shipment,
    returns,
  };
}
