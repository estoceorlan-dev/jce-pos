import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  transferInput,
  transferReceiptInput,
  transferDiscrepancyInput,
  transferApproval,
} from '@jce/shared';
describe('transfer request boundaries', () => {
  const variantId = randomUUID(),
    transferItemId = randomUUID();
  const action = {
    requestKey: randomUUID(),
    version: 1,
    note: 'Synthetic action',
  };
  it('requires positive unique draft lines and a destination', () => {
    const input = {
      destinationBranchId: randomUUID(),
      note: 'Synthetic transfer',
      lines: [{ variantId, quantity: '0.000001' }],
    };
    expect(transferInput.safeParse(input).success).toBe(true);
    for (const quantity of ['0', '-1', '0.0000001', '1e3'])
      expect(
        transferInput.safeParse({ ...input, lines: [{ variantId, quantity }] })
          .success,
      ).toBe(false);
    expect(
      transferInput.safeParse({
        ...input,
        lines: [...input.lines, ...input.lines],
      }).success,
    ).toBe(false);
  });
  it('separates actual receipts from explicit discrepancy resolutions', () => {
    const line = { transferItemId, quantity: '1', condition: 'damaged' };
    expect(
      transferReceiptInput.safeParse({ ...action, lines: [line] }).success,
    ).toBe(true);
    expect(
      transferReceiptInput.safeParse({ ...action, lines: [line, line] })
        .success,
    ).toBe(false);
    expect(
      transferDiscrepancyInput.safeParse({
        ...action,
        reasonCode: 'DAMAGED',
        lines: [line],
      }).success,
    ).toBe(false);
    expect(
      transferDiscrepancyInput.safeParse({
        ...action,
        reasonCode: 'DAMAGED',
        lines: [{ ...line, resolution: 'return_to_source' }],
      }).success,
    ).toBe(true);
  });
  it('requires a version, reason and fresh confirmation credential for review', () => {
    expect(transferApproval.safeParse(action).success).toBe(false);
    expect(
      transferApproval.safeParse({ ...action, password: 'test-only' }).success,
    ).toBe(true);
    expect(
      transferApproval.safeParse({
        ...action,
        password: 'test-only',
        version: 0,
      }).success,
    ).toBe(false);
    expect(
      transferApproval.safeParse({
        ...action,
        password: 'test-only',
        note: ' ',
      }).success,
    ).toBe(false);
  });
});
