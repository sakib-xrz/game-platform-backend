import { describe, expect, it } from 'vitest';
import { calculatePayout } from '@/modules/greedy/greedy.utils';
import { secureRandomBigIntBelow } from '@/utils/crypto-rng';

describe('Greedy utility rules', () => {
  it('calculates stake-inclusive integer payout', () => {
    expect(calculatePayout(500n, 10n, 1n)).toBe(5000n);
  });

  it('uses floor semantics for fractional atomic-unit payout', () => {
    expect(calculatePayout(5n, 3n, 2n)).toBe(7n);
  });

  it('returns secure RNG values within range', () => {
    for (let index = 0; index < 100; index += 1) {
      const sample = secureRandomBigIntBelow(925n);
      expect(sample.value >= 0n).toBe(true);
      expect(sample.value < 925n).toBe(true);
      expect(sample.entropy_digest).toHaveLength(64);
    }
  });
});
