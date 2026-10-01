import { describe, it, expect } from 'vitest';
import { returnShare } from '../../backend/src/reconciliation/calculations.js';
import { decimal } from '../../backend/src/db/decimal.js';
describe('original return allocation', () => {
  it('assigns centavo and cost residue to cumulative shares', () => {
    expect(
      ['0', '1', '2'].map((prior) => returnShare('10', '3', prior, '1')),
    ).toEqual(['3.33', '3.34', '3.33']);
    expect(
      ['0', '1', '2'].map((prior) => returnShare('1', '3', prior, '1', 6)),
    ).toEqual(['0.333333', '0.333334', '0.333333']);
    expect(returnShare('0.01', '3', '2', '1')).toBe('0.00');
  });
  it('reconciles irregular fractional returns without exceeding source amounts', () => {
    for (const total of ['0.01', '1.07', '112.37', '999999.99']) {
      let prior = '0',
        sum = decimal('0');
      for (const quantity of ['0.123456', '0.5', '0.376544']) {
        sum = sum.plus(returnShare(total, '1', prior, quantity));
        prior = decimal(prior).plus(quantity).toFixed(6);
      }
      expect(sum.eq(total)).toBe(true);
    }
    expect(() => returnShare('10', '1', '0.5', '0.500001')).toThrow();
    expect(() => returnShare('10', '1', '0', '0')).toThrow();
  });
});
