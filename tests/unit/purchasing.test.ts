import { describe, it, expect } from 'vitest';
import {
  baseQuantity,
  purchaseAmounts,
  receiptAmounts,
  type Terms,
} from '../../backend/src/purchasing/calculations.js';
const terms: Terms = {
  conversion: '6',
  unit_cost: '120',
  discount_rate: '0.1',
  tax_rate: '0.12',
  tax_inclusive: false,
  capitalize_tax: false,
};
describe('purchase calculations', () => {
  it('converts packs and separates supplier tax from inventory cost', () => {
    expect(baseQuantity('2', '6', false)).toBe('12.000000');
    expect(purchaseAmounts(terms, '2')).toEqual({
      net: '216.00',
      tax: '25.92',
      total: '241.92',
      discount: '24.00',
      stock_value: '216.000000',
    });
    expect(
      purchaseAmounts({ ...terms, capitalize_tax: true }, '2').stock_value,
    ).toBe('241.920000');
    expect(
      purchaseAmounts(
        { ...terms, unit_cost: '112', discount_rate: '0', tax_inclusive: true },
        '1',
      ),
    ).toMatchObject({
      net: '100.00',
      tax: '12.00',
      total: '112.00',
      stock_value: '100.000000',
    });
  });
  it('allocates cents cumulatively across fractional deliveries', () => {
    const fractional = {
      ...terms,
      unit_cost: '0.333333',
      discount_rate: '0',
      tax_rate: '0',
    };
    expect(
      ['0', '1', '2'].map(
        (before) => receiptAmounts(fractional, before, '1').total,
      ),
    ).toEqual(['0.33', '0.34', '0.33']);
    expect(receiptAmounts(fractional, '2', '1').stock_value).toBe('0.333333');
    expect(() => baseQuantity('0.5', '1', false)).toThrow();
    expect(() => baseQuantity('0.000001', '0.1', true)).toThrow();
    expect(baseQuantity('0.125', '2', true)).toBe('0.250000');
  });
});
