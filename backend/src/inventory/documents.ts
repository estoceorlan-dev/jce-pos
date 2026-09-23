import { randomUUID } from 'node:crypto';
import {
  stockDocumentInput,
  type StockCondition,
  type StockDocumentInput,
} from '@jce/shared';
import { checksum } from '../db/canonical.js';
import { decimal } from '../db/decimal.js';
import { allocateDocumentNumber } from '../db/numbering.js';
import type { Transaction } from '../db/transaction.js';
import { requireFound, HttpError } from '../management/common.js';
import {
  applyMovement,
  assertReconciled,
  balance,
  conflict,
  installation,
  inventoryEvent,
  ledgerBalance,
  lockInventory,
  movementValue,
} from './ledger.js';

type Document = {
  id: string;
  branch_id: string;
  installation_id: string;
  kind: StockDocumentInput['kind'];
  status: string;
  version: number;
  actor_id: string;
  approver_id: string | null;
  reason_code: string;
  content_hash: string;
  number: string | null;
  manifest: StockDocumentInput;
  opening_date: string | null;
};
type Item = {
  id: string;
  variant_id: string;
  condition: StockCondition;
  quantity: string;
  unit_cost: string;
  expected_version: number;
  expected_quantity: string;
  expected_value: string;
  expected_reserved: string;
  ledger_quantity: string;
  ledger_value: string;
  ledger_reserved: string;
  snapshot: Record<string, string>;
};
export async function documentDetail(
  tx: Transaction,
  branchId: string,
  id: string,
  lock = false,
) {
  const document = requireFound(
    (
      await tx.query<Document>(
        `SELECT * FROM stock_adjustments WHERE branch_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [branchId, id],
      )
    ).rows[0],
  );
  const items = (
    await tx.query<Item>(
      'SELECT * FROM stock_adjustment_items WHERE document_id=$1 ORDER BY variant_id,condition',
      [id],
    )
  ).rows;
  const report = items.map((i) => {
    const delta =
      document.kind === 'count'
        ? decimal(i.quantity).minus(i.expected_quantity).toFixed()
        : document.kind === 'reconcile'
          ? decimal(i.ledger_quantity).minus(i.expected_quantity).toFixed()
          : i.quantity;
    const next =
      document.kind === 'reconcile'
        ? {
            quantity: i.ledger_quantity,
            value: i.ledger_value,
            change: decimal(i.ledger_value).minus(i.expected_value).toFixed(6),
          }
        : movementValue(
            {
              quantity: i.expected_quantity,
              value: i.expected_value,
              reserved: i.expected_reserved,
            },
            delta,
            i.unit_cost,
          );
    return {
      ...i,
      delta,
      resulting_quantity: next.quantity,
      resulting_value: next.value,
      value_change: next.change,
    };
  });
  return {
    document,
    items: report,
    totalValueChange: report
      .reduce((sum, i) => sum.plus(i.value_change), decimal('0'))
      .toFixed(6),
  };
}
async function variantSnapshot(tx: Transaction, id: string) {
  const v = requireFound(
    (
      await tx.query<{
        sku: string;
        name: string;
        product_name: string;
        unit: string;
        conversion: string;
        fractional: boolean;
        archived: boolean;
      }>(
        'SELECT v.sku,v.name,p.name product_name,u.name unit,v.conversion,v.fractional,(v.archived OR p.archived OR u.archived) archived FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id WHERE v.id=$1',
        [id],
      )
    ).rows[0],
  );
  if (v.archived)
    throw conflict('Archived products or units cannot change stock.');
  return v;
}
export async function saveDocument(
  tx: Transaction,
  branchId: string,
  actorId: string,
  input: unknown,
  edit?: { id: string; version: number },
) {
  const data = stockDocumentInput.parse(input);
  const id = edit?.id ?? randomUUID();
  const installationId = await installation(tx, branchId);
  let nextVersion = 1;
  if (edit) {
    const prior = (await documentDetail(tx, branchId, id, true)).document;
    if (
      prior.status !== 'draft' ||
      prior.version !== edit.version ||
      prior.actor_id !== actorId
    )
      throw conflict('Only the author can edit the current draft version.');
    if (prior.kind !== data.kind)
      throw conflict('Document kind cannot change.');
    if (
      data.kind === 'count' &&
      checksum(
        prior.manifest.lines.map((l) => `${l.variantId}:${l.condition}`).sort(),
      ) !==
        checksum(data.lines.map((l) => `${l.variantId}:${l.condition}`).sort())
    )
      throw conflict(
        'Count scope is frozen. Cancel and create a new count to change scope.',
      );
    nextVersion = prior.version + 1;
  }
  await lockInventory(
    tx,
    branchId,
    data.lines.map((l) => l.variantId),
    data.kind === 'count' ? id : undefined,
  );
  if (data.sourceDocumentId) {
    const source = (await documentDetail(tx, branchId, data.sourceDocumentId))
      .document;
    if (source.status !== 'posted')
      throw conflict(
        'Corrections must reference a posted document in this branch.',
      );
  }
  if (
    data.openingDate &&
    data.openingDate >
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
  )
    throw conflict('Opening date cannot be in the future.');
  const items: Item[] = [];
  for (const line of data.lines) {
    const v = await variantSnapshot(tx, line.variantId);
    if (!v.fractional && !decimal(line.quantity).isInteger())
      throw conflict(`${v.sku} requires whole base-unit quantities.`);
    const current = await balance(tx, branchId, line.variantId, line.condition);
    const ledger = await ledgerBalance(
      tx,
      branchId,
      line.variantId,
      line.condition,
    );
    if (data.kind !== 'reconcile')
      await assertReconciled(tx, branchId, line.variantId, line.condition);
    if (data.kind === 'opening') {
      const used = await tx.query(
        'SELECT 1 FROM inventory_movements WHERE branch_id=$1 AND variant_id=$2 LIMIT 1',
        [branchId, line.variantId],
      );
      if (used.rowCount)
        throw conflict(
          'Opening stock is allowed only before the first movement for this variant.',
        );
    }
    if (
      data.kind === 'reconcile' &&
      (decimal(ledger.quantity).isNegative() ||
        decimal(ledger.value).isNegative() ||
        decimal(ledger.reserved).gt(ledger.quantity))
    )
      throw conflict(
        'The source ledger is invalid. Escalate to the maintainer; cached balances cannot repair source history.',
      );
    if (data.kind !== 'reconcile')
      movementValue(
        current,
        data.kind === 'count'
          ? decimal(line.quantity).minus(current.quantity).toFixed()
          : line.quantity,
        line.unitCost,
      );
    items.push({
      id: randomUUID(),
      variant_id: line.variantId,
      condition: line.condition,
      quantity: line.quantity,
      unit_cost: line.unitCost,
      expected_version: current.version,
      expected_quantity: current.quantity,
      expected_value: current.value,
      expected_reserved: current.reserved,
      ledger_quantity: ledger.quantity,
      ledger_value: ledger.value,
      ledger_reserved: ledger.reserved,
      snapshot: {
        sku: v.sku,
        name: v.name,
        productName: v.product_name,
        unit: v.unit,
        conversion: v.conversion,
      },
    });
  }
  const contentHash = checksum({
    data,
    items: items.map((item) => checksum(item)),
  });
  if (edit) {
    await tx.query('DELETE FROM stock_adjustment_items WHERE document_id=$1', [
      id,
    ]);
    await tx.query(
      'UPDATE stock_adjustments SET version=$2,reason_code=$3,note=$4,source_reference=$5,source_document_id=$6,opening_date=$7,manifest=$8,content_hash=$9 WHERE id=$1',
      [
        id,
        nextVersion,
        data.reasonCode,
        data.note,
        data.sourceReference,
        data.sourceDocumentId,
        data.openingDate,
        JSON.stringify(data),
        contentHash,
      ],
    );
  } else {
    await tx.query(
      'INSERT INTO stock_adjustments(id,branch_id,installation_id,kind,actor_id,reason_code,note,source_reference,source_document_id,opening_date,manifest,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        id,
        branchId,
        installationId,
        data.kind,
        actorId,
        data.reasonCode,
        data.note,
        data.sourceReference,
        data.sourceDocumentId,
        data.openingDate,
        JSON.stringify(data),
        contentHash,
      ],
    );
  }
  for (const i of items)
    await tx.query(
      'INSERT INTO stock_adjustment_items(id,document_id,variant_id,condition,quantity,unit_cost,expected_version,expected_quantity,expected_value,expected_reserved,ledger_quantity,ledger_value,ledger_reserved,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [
        i.id,
        id,
        i.variant_id,
        i.condition,
        i.quantity,
        i.unit_cost,
        i.expected_version,
        i.expected_quantity,
        i.expected_value,
        i.expected_reserved,
        i.ledger_quantity,
        i.ledger_value,
        i.ledger_reserved,
        JSON.stringify(i.snapshot),
      ],
    );
  if (data.kind === 'count' && !edit) {
    await tx.query(
      'INSERT INTO stock_counts(document_id,branch_id) VALUES($1,$2)',
      [id, branchId],
    );
    for (const variantId of new Set(data.lines.map((l) => l.variantId)))
      await tx.query(
        'INSERT INTO stock_count_items(document_id,variant_id) VALUES($1,$2)',
        [id, variantId],
      );
  }
  await inventoryEvent(tx, {
    branchId,
    actorId,
    id,
    version: nextVersion,
    action: edit ? 'edited' : 'drafted',
    reasonCode: data.reasonCode,
  });
  return { id, version: nextVersion };
}
export async function postDocument(
  tx: Transaction,
  branchId: string,
  id: string,
  approverId: string,
  version: number,
) {
  const { document: doc, items } = await documentDetail(tx, branchId, id, true);
  if (doc.status !== 'draft' || doc.version !== version)
    throw conflict('Document changed or was already finalized. Reload it.');
  if (doc.actor_id === approverId)
    throw new HttpError(
      403,
      'SELF_APPROVAL',
      'A different authorized user must review and post this document.',
    );
  const author = await tx.query(
    `SELECT 1 FROM users u JOIN branch_users b ON b.user_id=u.id JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_code=ur.role_code WHERE u.id=$1 AND b.branch_id=$2 AND NOT u.disabled AND rp.permission_code='inventory.manage'`,
    [doc.actor_id, branchId],
  );
  if (!author.rowCount)
    throw conflict('The author no longer has permission for this branch.');
  await lockInventory(
    tx,
    branchId,
    items.map((i) => i.variant_id),
    doc.kind === 'count' ? id : undefined,
  );
  for (const i of items) {
    await variantSnapshot(tx, i.variant_id);
    const current = await balance(tx, branchId, i.variant_id, i.condition);
    if (
      current.version !== i.expected_version ||
      !decimal(current.quantity).eq(i.expected_quantity) ||
      !decimal(current.value).eq(i.expected_value) ||
      !decimal(current.reserved).eq(i.expected_reserved)
    )
      throw conflict(
        'Stock changed since this draft. Its author must refresh and resubmit it.',
      );
    if (
      doc.kind === 'opening' &&
      (
        await tx.query(
          'SELECT 1 FROM inventory_movements WHERE branch_id=$1 AND variant_id=$2 LIMIT 1',
          [branchId, i.variant_id],
        )
      ).rowCount
    )
      throw conflict('Opening stock was already established for this variant.');
  }
  for (const i of items) {
    if (doc.kind === 'reconcile') {
      const ledger = await ledgerBalance(
        tx,
        branchId,
        i.variant_id,
        i.condition,
      );
      if (
        !decimal(ledger.quantity).eq(i.ledger_quantity) ||
        !decimal(ledger.value).eq(i.ledger_value) ||
        !decimal(ledger.reserved).eq(i.ledger_reserved)
      )
        throw conflict('Ledger changed. Refresh the correction for review.');
      await tx.query(
        'UPDATE inventories SET quantity=$4,value=$5,reserved=$6,version=version+1 WHERE branch_id=$1 AND variant_id=$2 AND condition=$3',
        [
          branchId,
          i.variant_id,
          i.condition,
          ledger.quantity,
          ledger.value,
          ledger.reserved,
        ],
      );
    } else
      await applyMovement(tx, {
        installationId: doc.installation_id,
        branchId,
        variantId: i.variant_id,
        condition: i.condition,
        quantity: i.delta,
        unitCost: i.unit_cost,
        sourceType: 'stock_adjustment',
        sourceId: id,
        sourceLineId: i.id,
        actorId: approverId,
        ...(doc.kind === 'count' ? { countId: id } : {}),
      });
  }
  const number = `STK-${await allocateDocumentNumber(tx, { documentId: id, branchId, installationId: doc.installation_id, series: 'STK' })}`;
  await tx.query(
    "UPDATE stock_adjustments SET status='posted',approver_id=$2,posted_at=now(),number=$3,version=version+1 WHERE id=$1",
    [id, approverId, number],
  );
  if (doc.kind === 'count')
    await tx.query(
      'UPDATE stock_counts SET released_at=now() WHERE document_id=$1',
      [id],
    );
  await inventoryEvent(tx, {
    branchId,
    actorId: approverId,
    id,
    version: version + 1,
    action: 'posted',
    reasonCode: doc.reason_code,
  });
  return { id, number, version: version + 1 };
}
export async function cancelDocument(
  tx: Transaction,
  branchId: string,
  id: string,
  actorId: string,
  version: number,
) {
  const { document: doc, items } = await documentDetail(tx, branchId, id, true);
  if (doc.status !== 'draft' || doc.version !== version)
    throw conflict('Document changed or was already finalized.');
  await lockInventory(
    tx,
    branchId,
    items.map((i) => i.variant_id),
    doc.kind === 'count' ? id : undefined,
  );
  await tx.query(
    "UPDATE stock_adjustments SET status='cancelled',version=version+1 WHERE id=$1",
    [id],
  );
  await tx.query(
    'UPDATE stock_counts SET released_at=now() WHERE document_id=$1',
    [id],
  );
  await inventoryEvent(tx, {
    branchId,
    actorId,
    id,
    version: version + 1,
    action: 'cancelled',
    reasonCode: doc.reason_code,
  });
  return { id, version: version + 1 };
}
