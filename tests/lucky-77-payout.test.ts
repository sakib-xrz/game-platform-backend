import { describe, expect, it } from 'vitest';
import { LUCKY_77_SLOT_MAP } from '@/modules/lucky-77/lucky-77.constant';
import {
  calculatePayout,
  isRetryableTransactionError,
  pickUniformSlotIndex,
  pickWeightedOption,
  slotIndexesForOption,
} from '@/modules/lucky-77/lucky-77.utils';

describe('Lucky 77 payout and slot helpers', () => {
  it('calculates stake-inclusive integer payout', () => {
    expect(calculatePayout(100n, 2n, 1n)).toBe(200n);
    expect(calculatePayout(100n, 8n, 1n)).toBe(800n);
  });

  it('uses floor semantics for fractional atomic-unit payout', () => {
    expect(calculatePayout(5n, 3n, 2n)).toBe(7n);
  });

  it('exposes the fixed nine-slot wheel map', () => {
    expect(LUCKY_77_SLOT_MAP).toEqual([
      'APPLE',
      'WATERMELON',
      'APPLE',
      'WATERMELON',
      'SEVENTY_SEVEN',
      'APPLE',
      'WATERMELON',
      'APPLE',
      'WATERMELON',
    ]);
  });

  it('lists matching slot indexes for each option code', () => {
    expect(slotIndexesForOption('APPLE')).toEqual([0, 2, 5, 7]);
    expect(slotIndexesForOption('WATERMELON')).toEqual([1, 3, 6, 8]);
    expect(slotIndexesForOption('SEVENTY_SEVEN')).toEqual([4]);
    expect(slotIndexesForOption('UNKNOWN')).toEqual([]);
  });

  it('picks a weighted option using the configured weight table', () => {
    const options = [
      { code: 'APPLE', probability_weight: 4n },
      { code: 'WATERMELON', probability_weight: 4n },
      { code: 'SEVENTY_SEVEN', probability_weight: 1n },
    ];
    expect(pickWeightedOption(options, 0n).code).toBe('APPLE');
    expect(pickWeightedOption(options, 3n).code).toBe('APPLE');
    expect(pickWeightedOption(options, 4n).code).toBe('WATERMELON');
    expect(pickWeightedOption(options, 7n).code).toBe('WATERMELON');
    expect(pickWeightedOption(options, 8n).code).toBe('SEVENTY_SEVEN');
  });

  it('picks a uniform slot among matching wheel positions', () => {
    expect(pickUniformSlotIndex('APPLE', 0n)).toBe(0);
    expect(pickUniformSlotIndex('APPLE', 3n)).toBe(7);
    expect(pickUniformSlotIndex('WATERMELON', 1n)).toBe(3);
    expect(pickUniformSlotIndex('SEVENTY_SEVEN', 0n)).toBe(4);
  });

  it('treats TransactionWriteConflict messages as retryable', () => {
    expect(
      isRetryableTransactionError(new Error('TransactionWriteConflict')),
    ).toBe(true);
    expect(isRetryableTransactionError(new Error('unrelated'))).toBe(false);
  });
});
