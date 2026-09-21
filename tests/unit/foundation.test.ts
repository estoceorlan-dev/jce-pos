import { describe, expect, it } from 'vitest';
import { canonicalJson, checksum } from '../../backend/src/db/canonical.js';
import {
  addDecimal,
  decimal,
  divideDecimal,
  multiplyDecimal,
  quantize,
} from '../../backend/src/db/decimal.js';

describe('decimal boundary and explicit rounding', () => {
  it('does not introduce binary floating point into calculations', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(multiplyDecimal('0.125', '19.96')).toBe('2.495');
    expect(addDecimal('9007199254740993.01', '0.01')).toBe(
      '9007199254740993.02',
    );
    expect(divideDecimal('840', '15', 6, 'half-up')).toBe('56.000000');
  });
  it('requires a policy rather than silently selecting business rules', () => {
    expect(quantize('2.485', 2, 'half-up')).toBe('2.49');
    expect(quantize('2.485', 2, 'half-even')).toBe('2.48');
    expect(quantize('-2.495', 2, 'half-up')).toBe('-2.50');
    expect(quantize('2.499', 2, 'down')).toBe('2.49');
    expect(() => divideDecimal('1', '0', 2, 'half-up')).toThrow();
    expect(() => quantize('1', 19, 'half-up')).toThrow();
    for (const value of [
      'NaN',
      'Infinity',
      '1e3',
      '01',
      ' 1',
      '1.0000000000000000001',
    ])
      expect(() => decimal(value)).toThrow();
    expect(() => decimal(0.1 as unknown as string)).toThrow();
  });
});
describe('canonical request and event checksums', () => {
  it('ignores object order but preserves array order and decimal representation', () => {
    expect(checksum({ b: '2', a: ['1', 2] })).toBe(
      checksum({ a: ['1', 2], b: '2' }),
    );
    expect(checksum(['1', '2'])).not.toBe(checksum(['2', '1']));
    expect(checksum({ amount: '1.00' })).not.toBe(checksum({ amount: '1' }));
  });
  it('rejects ambiguous JSON and bounds nested/large data', () => {
    for (const value of [
      undefined,
      1.5,
      NaN,
      Infinity,
      9007199254740992,
      new Date(),
      { x: undefined },
      [undefined],
      Array(2),
      'x'.repeat(60001),
    ])
      expect(() => canonicalJson(value)).toThrow();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
    expect(canonicalJson({ text: '₱', zero: 0 })).toBe('{"text":"₱","zero":0}');
  });
});
