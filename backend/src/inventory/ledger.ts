import { randomUUID } from 'node:crypto';
import { stockDelta, stockCost, type StockCondition } from '@jce/shared';
import { decimal } from '../db/decimal.js';
import { requireTransaction, type Transaction } from '../db/transaction.js';
import { HttpError } from '../management/common.js';
import { appendAudit } from '../audit/append.js';
import { appendOutbox } from '../sync/outbox.js';

export const conditions = ['sellable', 'damaged', 'quarantined'] as const;
export type Balance = {
  quantity: string;
  value: string;
  reserved: string;
  version: number;
};
export const conflict = (message: string) =>
  new HttpError(409, 'STOCK_CONFLICT', message);
export async function installation(tx: Transaction, branchId: string) {
  const row = (
    await tx.query<{ installation_id: string }>(
      'SELECT o.installation_id FROM branch_ownership o JOIN installations i ON i.id=o.installation_id WHERE o.branch_id=$1 AND i.singleton',
      [branchId],
    )
  ).rows[0];
  if (!row) throw conflict('This installation does not own this branch.');
  return row.installation_id;
}
/** All stock writers take these locks first, in the same order, including missing rows. */
export async function lockInventory(
  tx: Transaction,
  branchId: string,
  variants: string[],
  countId?: string,
) {
  requireTransaction(tx);
  for (const variantId of [...new Set(variants)].sort()) {
    await tx.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,74012005))',
      [`${branchId}:${variantId}`],
    );
    const frozen = await tx.query(
      'SELECT 1 FROM stock_counts c JOIN stock_count_items i ON i.document_id=c.document_id WHERE c.branch_id=$1 AND i.variant_id=$2 AND c.released_at IS NULL AND ($3::uuid IS NULL OR c.document_id<>$3)',
      [branchId, variantId, countId ?? null],
    );
    if (frozen.rowCount)
      throw conflict(
        'This item is frozen for a stock count. Post or cancel that count first.',
      );
    for (const condition of conditions) {
      await tx.query(
        'INSERT INTO inventories(branch_id,variant_id,condition) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [branchId, variantId, condition],
      );
      await tx.query(
        'SELECT 1 FROM inventories WHERE branch_id=$1 AND variant_id=$2 AND condition=$3 FOR UPDATE',
        [branchId, variantId, condition],
      );
    }
  }
}
export async function balance(
  tx: Transaction,
  branchId: string,
  variantId: string,
  condition: string,
): Promise<Balance> {
  return (
    await tx.query<Balance>(
      'SELECT quantity,value,reserved,version FROM inventories WHERE branch_id=$1 AND variant_id=$2 AND condition=$3',
      [branchId, variantId, condition],
    )
  ).rows[0]!;
}
export async function ledgerBalance(
  tx: Transaction,
  branchId: string,
  variantId: string,
  condition: string,
) {
  return (
    await tx.query<{ quantity: string; value: string; reserved: string }>(
      `SELECT COALESCE(sum(quantity),0)::text quantity, COALESCE(sum(value),0)::text value,
    CASE WHEN $3='sellable' THEN (SELECT COALESCE(sum(quantity),0) FROM inventory_reservations WHERE branch_id=$1 AND variant_id=$2 AND status='active') ELSE 0 END::text reserved
    FROM inventory_movements WHERE branch_id=$1 AND variant_id=$2 AND condition=$3`,
      [branchId, variantId, condition],
    )
  ).rows[0]!;
}
export async function assertReconciled(
  tx: Transaction,
  branchId: string,
  variantId: string,
  condition: string,
) {
  const cached = await balance(tx, branchId, variantId, condition);
  const ledger = await ledgerBalance(tx, branchId, variantId, condition);
  if (
    !['quantity', 'value', 'reserved'].every((k) =>
      decimal(cached[k as keyof typeof ledger]).eq(
        ledger[k as keyof typeof ledger],
      ),
    )
  )
    throw conflict(
      'Ledger mismatch. Review a reconciliation correction before changing this stock.',
    );
  return cached;
}
export function movementValue(
  current: Pick<Balance, 'quantity' | 'value' | 'reserved'>,
  delta: string,
  unitCost: string,
) {
  const quantity = decimal(delta);
  const nextQuantity = decimal(current.quantity).plus(quantity);
  if (nextQuantity.lt(current.reserved) || nextQuantity.isNegative())
    throw conflict('Insufficient available stock.');
  const change = quantity.isNegative()
    ? nextQuantity.isZero()
      ? decimal(current.value).negated()
      : decimal(current.value)
          .times(quantity)
          .div(current.quantity)
          .toDecimalPlaces(6)
    : quantity.times(unitCost).toDecimalPlaces(6);
  return {
    quantity: nextQuantity.toFixed(6),
    value: decimal(current.value).plus(change).toFixed(6),
    change: change.toFixed(6),
  };
}
/** Caller locks the complete document scope first; every future posting module must use this boundary. */
export async function applyMovement(
  tx: Transaction,
  input: {
    installationId: string;
    branchId: string;
    variantId: string;
    condition: StockCondition;
    quantity: string;
    unitCost: string;
    sourceType: string;
    sourceId: string;
    sourceLineId: string;
    actorId: string;
    countId?: string;
  },
) {
  requireTransaction(tx);
  stockDelta.parse(input.quantity);
  stockCost.parse(input.unitCost);
  await lockInventory(tx, input.branchId, [input.variantId], input.countId);
  const variant = (
    await tx.query<{ fractional: boolean; archived: boolean }>(
      'SELECT v.fractional,(v.archived OR p.archived OR u.archived) archived FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id WHERE v.id=$1',
      [input.variantId],
    )
  ).rows[0];
  if (
    !variant ||
    variant.archived ||
    (!variant.fractional && !decimal(input.quantity).isInteger())
  )
    throw conflict('Check product status and base-unit quantity.');
  const current = await assertReconciled(
    tx,
    input.branchId,
    input.variantId,
    input.condition,
  );
  const next = movementValue(current, input.quantity, input.unitCost);
  if (decimal(input.quantity).isZero()) return;
  await tx.query(
    'INSERT INTO inventory_movements(id,installation_id,branch_id,variant_id,condition,quantity,value,source_type,source_id,source_line_id,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      randomUUID(),
      input.installationId,
      input.branchId,
      input.variantId,
      input.condition,
      input.quantity,
      next.change,
      input.sourceType,
      input.sourceId,
      input.sourceLineId,
      input.actorId,
    ],
  );
  await tx.query(
    'UPDATE inventories SET quantity=$4,value=$5,version=version+1 WHERE branch_id=$1 AND variant_id=$2 AND condition=$3',
    [
      input.branchId,
      input.variantId,
      input.condition,
      next.quantity,
      next.value,
    ],
  );
}
export async function inventoryEvent(
  tx: Transaction,
  input: {
    branchId: string;
    actorId: string;
    id: string;
    version: number;
    action:
      'drafted' | 'edited' | 'cancelled' | 'posted' | 'allocated' | 'released';
    reasonCode?: string;
  },
) {
  const installationId = await installation(tx, input.branchId);
  await appendAudit(tx, {
    installationId,
    branchId: input.branchId,
    actorId: input.actorId,
    requestId: randomUUID(),
    action: `inventory.${input.action}`,
    entityType: 'inventory',
    entityId: input.id,
    entityVersion: input.version,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  });
  await appendOutbox(
    tx,
    {
      installationId,
      branchId: input.branchId,
      aggregateId: input.id,
      aggregateVersion: input.version,
    },
    {
      eventType: 'inventory.changed',
      aggregateType: 'inventory',
      payload: { entityId: input.id, action: input.action },
    },
  );
}
/** One SQL statement gives a consistent read-only snapshot even during concurrent posting. */
export async function reconcile(
  tx: Pick<Transaction, 'query'>,
  branchId: string | null = null,
) {
  return (
    await tx.query(
      `WITH m AS (
    SELECT branch_id,variant_id,condition,sum(quantity) quantity,sum(value) value FROM inventory_movements GROUP BY 1,2,3
  ), r AS (SELECT branch_id,variant_id,sum(quantity) reserved FROM inventory_reservations WHERE status='active' GROUP BY 1,2),
  keys AS (SELECT branch_id,variant_id,condition FROM inventories UNION SELECT branch_id,variant_id,condition FROM m UNION SELECT branch_id,variant_id,'sellable' FROM r)
  SELECT k.*,v.sku,COALESCE(i.quantity,0)::text balance_quantity,COALESCE(m.quantity,0)::text ledger_quantity,
   COALESCE(i.value,0)::text balance_value,COALESCE(m.value,0)::text ledger_value,
   COALESCE(i.reserved,0)::text balance_reserved,CASE WHEN k.condition='sellable' THEN COALESCE(r.reserved,0) ELSE 0 END::text ledger_reserved,
   (COALESCE(i.quantity,0)=COALESCE(m.quantity,0) AND COALESCE(i.value,0)=COALESCE(m.value,0) AND COALESCE(i.reserved,0)=CASE WHEN k.condition='sellable' THEN COALESCE(r.reserved,0) ELSE 0 END) matched
  FROM keys k LEFT JOIN inventories i USING(branch_id,variant_id,condition) LEFT JOIN m USING(branch_id,variant_id,condition)
  LEFT JOIN r USING(branch_id,variant_id) JOIN product_variants v ON v.id=k.variant_id
  WHERE ($1::uuid IS NULL OR k.branch_id=$1) ORDER BY k.branch_id,v.sku,k.condition`,
      [branchId],
    )
  ).rows;
}
