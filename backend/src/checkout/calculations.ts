import { Decimal } from 'decimal.js';
import type { TenderInput } from '@jce/shared';
import { decimal } from '../db/decimal.js';
import { conflict } from '../inventory/ledger.js';
const cents = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export function saleAmounts(
  price: string,
  quantity: string,
  discount: string,
  rate: string,
  inclusive: boolean,
) {
  const gross = cents(decimal(price).times(quantity));
  const reduced = gross.minus(discount);
  if (reduced.isNegative()) throw conflict('Line discount exceeds its price.');
  const net = inclusive ? cents(reduced.div(decimal('1').plus(rate))) : reduced;
  const total = inclusive ? reduced : net.plus(cents(net.times(rate)));
  return {
    gross: gross.toFixed(2),
    discount: decimal(discount).toFixed(2),
    net: net.toFixed(2),
    tax: total.minus(net).toFixed(2),
    total: total.toFixed(2),
  };
}
export function settleTenders(
  total: string,
  payments: TenderInput[],
  allowed: string[],
) {
  let cash = decimal('0'),
    noncash = decimal('0');
  for (const p of payments) {
    if (!allowed.includes(p.method))
      throw conflict('This payment method is not enabled for the branch.');
    if (p.method !== 'cash' && !p.reference.trim())
      throw conflict('Card and e-wallet payments require a reference.');
    if (p.method === 'cash') cash = cash.plus(p.amount);
    else noncash = noncash.plus(p.amount);
  }
  const due = decimal(total).minus(noncash);
  if (due.isNegative())
    throw conflict('Noncash payments cannot exceed the sale total.');
  if (cash.lt(due)) throw conflict('Payment does not cover the sale total.');
  if (due.isZero() && cash.gt(0))
    throw conflict('Remove cash when noncash already covers the sale.');
  const change = cash.minus(due);
  return {
    change: change.toFixed(2),
    cashEffect: due.toFixed(2),
    payments: payments.map((p) => ({
      ...p,
      amount: decimal(p.amount).toFixed(2),
      applied:
        p.method === 'cash' ? due.toFixed(2) : decimal(p.amount).toFixed(2),
    })),
  };
}
