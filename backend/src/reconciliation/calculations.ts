import { decimal } from '../db/decimal.js';
/** Allocate cumulative rounded shares, so the final unit takes exactly the remainder. */
export function returnShare(
  total: string,
  quantity: string,
  prior: string,
  requested: string,
  scale = 2,
) {
  const q = decimal(quantity),
    p = decimal(prior),
    r = decimal(requested);
  if (q.lte(0) || p.lt(0) || r.lte(0) || p.plus(r).gt(q))
    throw new Error('Return quantity exceeds eligibility.');
  return decimal(total)
    .times(p.plus(r))
    .div(q)
    .toDecimalPlaces(scale)
    .minus(decimal(total).times(p).div(q).toDecimalPlaces(scale))
    .toFixed(scale);
}
