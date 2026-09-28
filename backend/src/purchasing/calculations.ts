import { Decimal } from 'decimal.js';
import { decimal } from '../db/decimal.js';
export type Terms = {
  unit_cost: string;
  discount_rate: string;
  tax_rate: string;
  tax_inclusive: boolean;
  capitalize_tax: boolean;
  conversion: string;
};
const round = (v: Decimal, scale: number) =>
  v.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
/** Cumulative allocation means splitting a delivery cannot duplicate rounding cents. */
export function purchaseAmounts(terms: Terms, quantity: string) {
  const gross = decimal(quantity).times(terms.unit_cost);
  const discounted = gross.times(decimal('1').minus(terms.discount_rate));
  const net = terms.tax_inclusive
    ? discounted.div(decimal('1').plus(terms.tax_rate))
    : discounted;
  const tax = terms.tax_inclusive
    ? discounted.minus(net)
    : net.times(terms.tax_rate);
  const settledTotal = round(net.plus(tax), 2);
  const settledNet = round(net, 2);
  return {
    net: settledNet.toFixed(2),
    tax: settledTotal.minus(settledNet).toFixed(2),
    total: settledTotal.toFixed(2),
    discount: round(gross.minus(discounted), 2).toFixed(2),
    stock_value: round(terms.capitalize_tax ? net.plus(tax) : net, 6).toFixed(
      6,
    ),
  };
}
export function receiptAmounts(terms: Terms, before: string, quantity: string) {
  const start = purchaseAmounts(terms, before);
  const end = purchaseAmounts(terms, decimal(before).plus(quantity).toFixed());
  return Object.fromEntries(
    Object.keys(start).map((k) => [
      k,
      decimal(end[k as keyof typeof end])
        .minus(start[k as keyof typeof start])
        .toFixed(k === 'stock_value' ? 6 : 2),
    ]),
  ) as ReturnType<typeof purchaseAmounts>;
}
export function baseQuantity(
  quantity: string,
  conversion: string,
  fractional: boolean,
) {
  const result = decimal(quantity).times(conversion);
  if (
    result.decimalPlaces() > 6 ||
    (!fractional && !result.isInteger()) ||
    result.gte('1000000000000')
  )
    throw new Error(
      'Quantity conversion must fit six decimal places and the base-unit fractional policy.',
    );
  return result.toFixed(6);
}
