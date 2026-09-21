import { Decimal } from 'decimal.js';

const Exact = Decimal.clone({ precision: 100, toExpNeg: -100, toExpPos: 100 });
export type RoundingPolicy = 'half-up' | 'half-even' | 'down';
const modes = {
  'half-up': Decimal.ROUND_HALF_UP,
  'half-even': Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_DOWN,
} as const;
export function decimal(value: string): Decimal {
  if (
    typeof value !== 'string' ||
    !/^-?(0|[1-9]\d{0,23})(\.\d{1,18})?$/.test(value)
  )
    throw new Error('Decimal must be a bounded base-10 string.');
  return new Exact(value);
}
export function addDecimal(a: string, b: string): string {
  return decimal(a).plus(decimal(b)).toFixed();
}
export function multiplyDecimal(a: string, b: string): string {
  return decimal(a).times(decimal(b)).toFixed();
}
export function quantize(
  value: string,
  scale: number,
  policy: RoundingPolicy,
): string {
  if (
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 18 ||
    !Object.hasOwn(modes, policy)
  )
    throw new Error('Explicit scale and rounding policy required.');
  return decimal(value).toFixed(scale, modes[policy]);
}
export function divideDecimal(
  a: string,
  b: string,
  scale: number,
  policy: RoundingPolicy,
): string {
  const divisor = decimal(b);
  if (divisor.isZero()) throw new Error('Cannot divide by zero.');
  if (
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 18 ||
    !Object.hasOwn(modes, policy)
  )
    throw new Error('Explicit scale and rounding policy required.');
  return decimal(a).dividedBy(divisor).toFixed(scale, modes[policy]);
}
