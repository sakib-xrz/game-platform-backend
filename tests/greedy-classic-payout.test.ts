import { describe, expect, it } from 'vitest';
import { calculatePayout } from '@/modules/greedy-classic/greedy-classic.utils';

describe('Greedy Classic payout math', () => {
  it('calculates stake-inclusive integer payout for Falcon…Diamond multipliers', () => {
    expect(calculatePayout(100n, 4n, 1n)).toBe(400n);
    expect(calculatePayout(100n, 5n, 1n)).toBe(500n);
    expect(calculatePayout(100n, 6n, 1n)).toBe(600n);
    expect(calculatePayout(100n, 7n, 1n)).toBe(700n);
    expect(calculatePayout(100n, 8n, 1n)).toBe(800n);
    expect(calculatePayout(100n, 10n, 1n)).toBe(1000n);
    expect(calculatePayout(100n, 15n, 1n)).toBe(1500n);
    expect(calculatePayout(100n, 20n, 1n)).toBe(2000n);
  });

  it('uses floor semantics for fractional atomic-unit payout', () => {
    expect(calculatePayout(5n, 3n, 2n)).toBe(7n);
  });
});
