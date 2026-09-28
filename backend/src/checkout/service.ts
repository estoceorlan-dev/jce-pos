import { randomUUID } from 'node:crypto';
import {
  businessInput,
  branchSettingsInput,
  cartInput,
  type CartInput,
  type CheckoutInput,
} from '@jce/shared';
import type { Transaction } from '../db/transaction.js';
import { checksum } from '../db/canonical.js';
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
import { baseQuantity } from '../purchasing/calculations.js';
import { saleAmounts, settleTenders } from './calculations.js';

type Product = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  conversion: string;
  fractional: boolean;
  price: string;
  price_version: number;
  variant_version: number;
  rate: string;
  inclusive: boolean;
  tax_code: string;
  tax_version: number;
};
export const productSql = `SELECT v.id,v.sku,p.name||' / '||v.name AS name,u.name AS unit,v.conversion,v.fractional,pr.amount::text price,pr.version price_version,v.version variant_version,COALESCE(t.rate,0)::text rate,COALESCE(t.inclusive,false) inclusive,COALESCE(t.code,'NO_TAX') tax_code,COALESCE(t.version,0) tax_version FROM product_variants v JOIN products p ON p.id=v.product_id JOIN product_units u ON u.id=v.unit_id JOIN product_prices pr ON pr.variant_id=v.id AND pr.branch_id=$1 LEFT JOIN tax_codes t ON t.id=v.tax_code_id WHERE NOT v.archived AND NOT p.archived AND NOT u.archived AND (t.id IS NULL OR NOT t.archived)`;
type QuoteLine = Product &
  ReturnType<typeof saleAmounts> & { quantity: string; baseQuantity: string };
export type Quote = {
  lines: QuoteLine[];
  net: string;
  tax: string;
  total: string;
  discount: string;
  customer: string;
  business: ReturnType<typeof businessInput.parse>;
  settings: ReturnType<typeof branchSettingsInput.parse>;
  branch: { name: string; code: string };
};
type Cart = {
  id: string;
  branch_id: string;
  actor_id: string;
  session_id: string;
  version: number;
  status: string;
  input: CartInput;
  quote: Quote;
};
type RegisterSession = {
  id: string;
  actor_id: string;
  terminal_id: string;
  register_id: string;
  status: string;
  register: string;
  terminal: string;
  archived: boolean;
};
export async function checkoutEvent(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
  version: number,
  kind: 'cart' | 'sale' | 'register_session' | 'approval' | 'print',
  action:
    | 'opened'
    | 'created'
    | 'edited'
    | 'held'
    | 'active'
    | 'cancelled'
    | 'posted'
    | 'approved'
    | 'requested'
    | 'confirmed'
    | 'failed',
) {
  const installationId = await installation(tx, branchId);
  await appendAudit(tx, {
    installationId,
    branchId,
    actorId,
    requestId: randomUUID(),
    action: `checkout.${action}`,
    entityType: kind,
    entityId: id,
    entityVersion: version,
  });
  await appendOutbox(
    tx,
    { installationId, branchId, aggregateId: id, aggregateVersion: version },
    {
      eventType: 'checkout.changed',
      aggregateType: 'checkout',
      payload: { entityId: id, kind, action },
    },
  );
}
export async function configuration(tx: Transaction, branchId: string) {
  const b = (await tx.query('SELECT value,version FROM business_settings'))
    .rows[0]!;
  const s = (
    await tx.query(
      'SELECT value,version FROM branch_settings WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0];
  const business = businessInput.safeParse({ ...b.value, version: b.version });
  const settings = branchSettingsInput.safeParse({
    ...s?.value,
    version: s?.version,
  });
  if (!business.success || !settings.success || !business.data.taxConfirmed)
    throw conflict(
      'Complete business and branch payment settings and confirm tax configuration before checkout.',
    );
  return { business: business.data, settings: settings.data };
}
export async function liveSession(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
) {
  const row = requireFound(
    (
      await tx.query<RegisterSession>(
        `SELECT s.*,r.code register,t.code terminal,r.archived FROM register_sessions s JOIN registers r ON r.id=s.register_id JOIN terminals t ON t.id=s.terminal_id WHERE s.id=$1 AND s.branch_id=$2 FOR UPDATE OF s`,
        [id, branchId],
      )
    ).rows[0],
  );
  if (row.actor_id !== actorId)
    throw new HttpError(
      403,
      'CASHIER_REQUIRED',
      'Use a register session opened by your account.',
    );
  if (row.status !== 'open' || row.archived)
    throw conflict('This register session is not open for checkout.');
  return row;
}
export async function openRegister(
  tx: Transaction,
  branchId: string,
  actorId: string,
  registerId: string,
  openingFloat: string,
) {
  const register = requireFound(
    (
      await tx.query<{ terminal_id: string }>(
        `SELECT terminal_id FROM registers WHERE id=$1 AND branch_id=$2 AND NOT archived FOR UPDATE`,
        [registerId, branchId],
      )
    ).rows[0],
  );
  if (
    (
      await tx.query(
        "SELECT 1 FROM register_sessions WHERE terminal_id=$1 AND status='open'",
        [register.terminal_id],
      )
    ).rowCount
  )
    throw conflict('This terminal already has an open register session.');
  const id = randomUUID();
  await tx.query(
    'INSERT INTO register_sessions(id,branch_id,installation_id,register_id,terminal_id,actor_id,opening_float) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      id,
      branchId,
      await installation(tx, branchId),
      registerId,
      register.terminal_id,
      actorId,
      openingFloat,
    ],
  );
  await tx.query(
    "INSERT INTO register_cash_entries(id,session_id,actor_id,kind,amount) VALUES($1,$2,$3,'opening',$4)",
    [randomUUID(), id, actorId, openingFloat],
  );
  await checkoutEvent(
    tx,
    branchId,
    actorId,
    id,
    1,
    'register_session',
    'opened',
  );
  return { id };
}
export async function quoteCart(
  tx: Transaction,
  branchId: string,
  input: CartInput,
): Promise<Quote> {
  const config = await configuration(tx, branchId);
  let customer = 'Walk-in customer';
  if (input.customerId)
    customer = requireFound(
      (
        await tx.query<{ name: string }>(
          'SELECT name FROM customers WHERE id=$1 AND branch_id=$2 AND NOT archived',
          [input.customerId, branchId],
        )
      ).rows[0],
    ).name;
  const branch = requireFound(
    (
      await tx.query<{ name: string; code: string }>(
        'SELECT name,code FROM branches WHERE id=$1 AND archived_at IS NULL',
        [branchId],
      )
    ).rows[0],
  );
  const lines: QuoteLine[] = [];
  for (const line of input.lines) {
    const product = (
      await tx.query<Product>(`${productSql} AND v.id=$2`, [
        branchId,
        line.variantId,
      ])
    ).rows[0];
    if (!product)
      throw conflict(
        'A cart product is archived, unavailable or missing its branch price. Review the cart.',
      );
    let converted: string;
    try {
      converted = baseQuantity(
        line.quantity,
        product.conversion,
        product.fractional,
      );
    } catch {
      throw conflict('Check the quantity and base-unit conversion.');
    }
    lines.push({
      ...product,
      quantity: decimal(line.quantity).toFixed(6),
      baseQuantity: converted,
      ...saleAmounts(
        product.price,
        line.quantity,
        line.discount,
        product.rate,
        product.inclusive,
      ),
    });
  }
  const sums = {
    net: decimal('0'),
    tax: decimal('0'),
    total: decimal('0'),
    discount: decimal('0'),
  };
  for (const line of lines)
    for (const k of Object.keys(sums) as (keyof typeof sums)[])
      sums[k] = sums[k].plus(line[k]);
  if (sums.total.lte(0) || sums.total.gte('1000000000000'))
    throw conflict('The sale total must be positive and below PHP 1 trillion.');
  return {
    ...config,
    branch,
    customer,
    lines,
    net: sums.net.toFixed(2),
    tax: sums.tax.toFixed(2),
    total: sums.total.toFixed(2),
    discount: sums.discount.toFixed(2),
  };
}
export async function getCart(
  tx: Transaction,
  branchId: string,
  id: string,
  lock = false,
) {
  return requireFound(
    (
      await tx.query<Cart>(
        `SELECT * FROM checkout_carts WHERE id=$1 AND branch_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [id, branchId],
      )
    ).rows[0],
  );
}
function author(cart: Cart, actorId: string, version: number) {
  if (cart.actor_id !== actorId)
    throw new HttpError(
      403,
      'AUTHOR_REQUIRED',
      'Only the cashier who created this cart can change or post it.',
    );
  if (cart.version !== version || !['active', 'held'].includes(cart.status))
    throw conflict('Cart changed or was finalized. Reload it.');
}
export async function saveCart(
  tx: Transaction,
  branchId: string,
  actorId: string,
  raw: unknown,
  edit?: { id: string; version: number },
) {
  const input = cartInput.parse(raw);
  if (edit) {
    const cart = await getCart(tx, branchId, edit.id, true);
    author(cart, actorId, edit.version);
    if (cart.session_id !== input.sessionId || cart.status !== 'active')
      throw conflict(
        'Resume this cart before editing; its register session cannot change.',
      );
  }
  await liveSession(tx, branchId, actorId, input.sessionId);
  const quote = await quoteCart(tx, branchId, input);
  const id = edit?.id ?? randomUUID(),
    version = edit ? edit.version + 1 : 1;
  if (edit)
    await tx.query(
      'UPDATE checkout_carts SET input=$2,quote=$3,version=$4,updated_at=now() WHERE id=$1',
      [id, JSON.stringify(input), JSON.stringify(quote), version],
    );
  else
    await tx.query(
      'INSERT INTO checkout_carts(id,branch_id,actor_id,session_id,input,quote) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        branchId,
        actorId,
        input.sessionId,
        JSON.stringify(input),
        JSON.stringify(quote),
      ],
    );
  await checkoutEvent(
    tx,
    branchId,
    actorId,
    id,
    version,
    'cart',
    edit ? 'edited' : 'created',
  );
  return { id, version };
}
export async function cartTransition(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
  version: number,
  action: 'hold' | 'resume' | 'cancel',
) {
  const cart = await getCart(tx, branchId, id, true);
  author(cart, actorId, version);
  if (
    (action === 'hold' && cart.status !== 'active') ||
    (action === 'resume' && cart.status !== 'held')
  )
    throw conflict('This cart cannot make that transition.');
  const status =
    action === 'hold' ? 'held' : action === 'resume' ? 'active' : 'cancelled';
  await tx.query(
    'UPDATE checkout_carts SET status=$2,version=version+1,updated_at=now() WHERE id=$1',
    [id, status],
  );
  await checkoutEvent(tx, branchId, actorId, id, version + 1, 'cart', status);
  return { id, version: version + 1 };
}
async function eligible(
  tx: Transaction,
  branchId: string,
  actorId: string,
  permission: string,
) {
  if (
    !(
      await tx.query(
        'SELECT 1 FROM users u JOIN branch_users b ON b.user_id=u.id JOIN user_roles r ON r.user_id=u.id JOIN role_permissions p ON p.role_code=r.role_code WHERE u.id=$1 AND NOT u.disabled AND b.branch_id=$2 AND p.permission_code=$3',
        [actorId, branchId, permission],
      )
    ).rowCount
  )
    throw conflict(
      'The cashier or reviewer no longer has permission for this branch.',
    );
}
export async function approveDiscount(
  tx: Transaction,
  branchId: string,
  actorId: string,
  id: string,
  version: number,
  reason: string,
) {
  const cart = await getCart(tx, branchId, id, true);
  if (cart.actor_id === actorId)
    throw new HttpError(
      403,
      'SELF_APPROVAL',
      'A different authorized reviewer must approve this discount.',
    );
  if (
    cart.status !== 'active' ||
    cart.version !== version ||
    decimal(cart.quote.discount).isZero()
  )
    throw conflict('An active unchanged discounted cart is required.');
  await eligible(tx, branchId, cart.actor_id, 'checkout.use');
  await liveSession(tx, branchId, cart.actor_id, cart.session_id);
  if (
    checksum(await quoteCart(tx, branchId, cart.input)) !== checksum(cart.quote)
  )
    throw conflict(
      'Prices or settings changed. The cashier must save and review the cart again.',
    );
  const approvalId = randomUUID();
  await tx.query(
    "INSERT INTO checkout_approvals(id,cart_id,cart_version,actor_id,reason,quote_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '5 minutes')",
    [approvalId, id, version, actorId, reason, checksum(cart.quote)],
  );
  await checkoutEvent(
    tx,
    branchId,
    actorId,
    approvalId,
    1,
    'approval',
    'approved',
  );
  return { id: approvalId };
}
export async function postSale(
  tx: Transaction,
  branchId: string,
  actorId: string,
  cartId: string,
  input: CheckoutInput,
) {
  const cart = await getCart(tx, branchId, cartId, true);
  author(cart, actorId, input.version);
  if (cart.status !== 'active')
    throw conflict('Resume the held cart before checkout.');
  const register = await liveSession(tx, branchId, actorId, cart.session_id);
  const quote = await quoteCart(tx, branchId, cart.input);
  if (checksum(quote) !== checksum(cart.quote))
    throw conflict(
      'Prices, tax, customer or settings changed. Save and review the cart again.',
    );
  let approvalId: string | null = null;
  if (decimal(quote.discount).gt(0)) {
    const approval = (
      await tx.query<{ id: string; actor_id: string }>(
        'SELECT id,actor_id FROM checkout_approvals WHERE cart_id=$1 AND cart_version=$2 AND quote_hash=$3 AND expires_at>clock_timestamp() AND actor_id<>$4 ORDER BY created_at DESC LIMIT 1',
        [cartId, cart.version, checksum(quote), actorId],
      )
    ).rows[0];
    if (!approval)
      throw conflict(
        'This exact discount needs a different reviewer approval within five minutes.',
      );
    await eligible(tx, branchId, approval.actor_id, 'checkout.approve');
    approvalId = approval.id;
  }
  const settlement = settleTenders(
    quote.total,
    input.payments,
    quote.settings.tenders,
  );
  await lockInventory(
    tx,
    branchId,
    quote.lines.map((l) => l.id),
  );
  const id = randomUUID(),
    installationId = await installation(tx, branchId);
  const series = quote.business.receiptSeries;
  const number = `${series}-${await allocateDocumentNumber(tx, { documentId: id, branchId, installationId, series })}`;
  const cashier = requireFound(
    (
      await tx.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id=$1',
        [actorId],
      )
    ).rows[0],
  ).display_name;
  const snapshot = {
    business: quote.business,
    branch: quote.branch,
    customer: quote.customer,
    cashier,
    register: register.register,
    terminal: register.terminal,
    paperWidth: quote.settings.paperWidth,
  };
  await tx.query(
    'INSERT INTO sales(id,installation_id,branch_id,session_id,cart_id,request_key,actor_id,customer_id,approval_id,number,net,tax,total,discount,cash_effect,change,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
    [
      id,
      installationId,
      branchId,
      cart.session_id,
      cartId,
      input.requestKey,
      actorId,
      cart.input.customerId,
      approvalId,
      number,
      quote.net,
      quote.tax,
      quote.total,
      quote.discount,
      settlement.cashEffect,
      settlement.change,
      JSON.stringify(snapshot),
    ],
  );
  for (const line of quote.lines) {
    const itemId = randomUUID();
    const before = await balance(tx, branchId, line.id, 'sellable');
    await applyMovement(tx, {
      installationId,
      branchId,
      variantId: line.id,
      condition: 'sellable',
      quantity: decimal(line.baseQuantity).negated().toFixed(6),
      unitCost: '0',
      sourceType: 'sale',
      sourceId: id,
      sourceLineId: itemId,
      actorId,
    });
    const after = await balance(tx, branchId, line.id, 'sellable');
    const cost = decimal(before.value).minus(after.value).toFixed(6);
    await tx.query(
      'INSERT INTO sale_items(id,sale_id,variant_id,quantity,base_quantity,price,discount,net,tax,total,cost,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        itemId,
        id,
        line.id,
        line.quantity,
        line.baseQuantity,
        line.price,
        line.discount,
        line.net,
        line.tax,
        line.total,
        cost,
        JSON.stringify(line),
      ],
    );
  }
  for (const p of settlement.payments)
    await tx.query(
      'INSERT INTO sale_payments(id,sale_id,method,amount,applied,reference) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), id, p.method, p.amount, p.applied, p.reference],
    );
  await tx.query(
    "INSERT INTO register_cash_entries(id,session_id,actor_id,kind,amount,sale_id) VALUES($1,$2,$3,'sale',$4,$5)",
    [randomUUID(), cart.session_id, actorId, settlement.cashEffect, id],
  );
  if (cart.input.customerId)
    await tx.query(
      "INSERT INTO customer_transactions(id,branch_id,customer_id,source_type,source_id,amount) VALUES($1,$2,$3,'sale',$4,$5)",
      [randomUUID(), branchId, cart.input.customerId, id, quote.total],
    );
  await tx.query("UPDATE sales SET status='posted' WHERE id=$1", [id]);
  await tx.query(
    "UPDATE checkout_carts SET status='posted',version=version+1,updated_at=now() WHERE id=$1",
    [cartId],
  );
  if (
    approvalId &&
    !(
      await tx.query(
        'SELECT 1 FROM checkout_approvals WHERE id=$1 AND expires_at>clock_timestamp()',
        [approvalId],
      )
    ).rowCount
  )
    throw conflict(
      'Discount approval expired before posting. Request review again.',
    );
  await checkoutEvent(
    tx,
    branchId,
    actorId,
    cartId,
    cart.version + 1,
    'cart',
    'posted',
  );
  await checkoutEvent(tx, branchId, actorId, id, 1, 'sale', 'posted');
  return { id, number };
}
export async function saleDetail(
  tx: Transaction,
  branchId: string,
  id: string,
) {
  const sale = requireFound(
    (
      await tx.query('SELECT * FROM sales WHERE id=$1 AND branch_id=$2', [
        id,
        branchId,
      ])
    ).rows[0],
  );
  const lines = (
    await tx.query(
      'SELECT id,variant_id,quantity,base_quantity,price,discount,net,tax,total,snapshot FROM sale_items WHERE sale_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  const payments = (
    await tx.query(
      'SELECT method,amount,applied,reference FROM sale_payments WHERE sale_id=$1 ORDER BY method',
      [id],
    )
  ).rows;
  const prints = (
    await tx.query(
      'SELECT p.id,p.actor_id,p.outcome,p.attempt_id,p.occurred_at,u.display_name actor FROM receipt_print_events p JOIN users u ON u.id=p.actor_id WHERE p.sale_id=$1 ORDER BY p.occurred_at,p.id',
      [id],
    )
  ).rows;
  return { sale, lines, payments, prints };
}
