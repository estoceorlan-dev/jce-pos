import { describe, expect, it } from 'vitest';
import { stockDocumentInput, stockQuantity } from '@jce/shared';
import { movementValue } from '../../backend/src/inventory/ledger.js';
describe('inventory precision and boundaries', () => {
  it('keeps fractional cost precision and consumes the final rounding residue', () => {
    expect(
      movementValue({ quantity: '3', value: '1', reserved: '0' }, '-1', '0'),
    ).toEqual({ quantity: '2.000000', value: '0.666667', change: '-0.333333' });
    expect(
      movementValue(
        { quantity: '2', value: '0.666667', reserved: '0' },
        '-2',
        '0',
      ),
    ).toEqual({ quantity: '0.000000', value: '0.000000', change: '-0.666667' });
    expect(
      movementValue(
        { quantity: '2', value: '20', reserved: '1' },
        '0.5',
        '12.123456',
      ).value,
    ).toBe('26.061728');
    expect(() =>
      movementValue(
        { quantity: '2', value: '20', reserved: '1' },
        '-1.000001',
        '0',
      ),
    ).toThrow('Insufficient');
  });
  it('requires bounded decimal strings and explicit opening evidence', () => {
    for (const v of [1, '1e2', '0.0000001', '-1', '1000000000000'])
      expect(stockQuantity.safeParse(v).success).toBe(false);
    expect(
      stockDocumentInput.safeParse({
        kind: 'opening',
        reasonCode: 'OPENING',
        note: 'test',
        lines: [],
      }).success,
    ).toBe(false);
  });
});
