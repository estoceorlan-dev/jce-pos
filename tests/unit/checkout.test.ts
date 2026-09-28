import { describe, expect, it } from 'vitest';
import { checkoutInput } from '@jce/shared';
import {
  saleAmounts,
  settleTenders,
} from '../../backend/src/checkout/calculations.js';
describe('checkout amounts and tender boundaries', () => {
  it('rounds line extensions and applies discounts before inclusive/exclusive tax', () => {
    expect(saleAmounts('112', '2', '22.40', '0.12', true)).toEqual({
      gross: '224.00',
      discount: '22.40',
      net: '180.00',
      tax: '21.60',
      total: '201.60',
    });
    expect(saleAmounts('100', '2', '20', '0.12', false)).toMatchObject({
      net: '180.00',
      tax: '21.60',
      total: '201.60',
    });
    expect(saleAmounts('0.05', '0.5', '0', '0', false).total).toBe('0.03');
    expect(() => saleAmounts('10', '1', '11', '0', false)).toThrow('discount');
  });
  it('allocates split tender and change without treating cash handed over as revenue', () => {
    expect(
      settleTenders(
        '201.60',
        [
          { method: 'card', amount: '100', reference: 'AUTH-123' },
          { method: 'cash', amount: '150', reference: '' },
        ],
        ['cash', 'card'],
      ),
    ).toMatchObject({
      cashEffect: '101.60',
      change: '48.40',
      payments: [{ applied: '100.00' }, { applied: '101.60' }],
    });
    expect(() =>
      settleTenders(
        '10',
        [{ method: 'card', amount: '11', reference: 'A' }],
        ['card'],
      ),
    ).toThrow('exceed');
    expect(() =>
      settleTenders(
        '10',
        [{ method: 'ewallet', amount: '10', reference: '' }],
        ['ewallet'],
      ),
    ).toThrow('reference');
    expect(() =>
      settleTenders(
        '10',
        [{ method: 'cash', amount: '9', reference: '' }],
        ['cash'],
      ),
    ).toThrow('cover');
    expect(() =>
      settleTenders(
        '10',
        [
          { method: 'card', amount: '10', reference: 'A' },
          { method: 'cash', amount: '1', reference: '' },
        ],
        ['cash', 'card'],
      ),
    ).toThrow('Remove cash');
    expect(() =>
      settleTenders(
        '10',
        [{ method: 'ewallet', amount: '10', reference: 'A' }],
        ['cash'],
      ),
    ).toThrow('not enabled');
  });
  it('rejects duplicate tender methods and excess precision', () => {
    const input = {
      version: 1,
      requestKey: '00000000-0000-4000-8000-000000000001',
      payments: [
        { method: 'cash', amount: '1', reference: '' },
        { method: 'cash', amount: '1', reference: '' },
      ],
    };
    expect(checkoutInput.safeParse(input).success).toBe(false);
    expect(
      checkoutInput.safeParse({
        ...input,
        payments: [{ method: 'cash', amount: '1.001', reference: '' }],
      }).success,
    ).toBe(false);
  });
});
