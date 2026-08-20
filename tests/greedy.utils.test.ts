import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import {
  calculatePayout,
  isRetryableTransactionError,
} from '@/modules/greedy/greedy.utils';
import { secureRandomBigIntBelow } from '@/utils/crypto-rng';

describe('Greedy utility rules', () => {
  it('retries Prisma transaction and raw PostgreSQL serialization conflicts', () => {
    const prisma_conflict = new Prisma.PrismaClientKnownRequestError(
      'Transaction write conflict',
      { code: 'P2034', clientVersion: 'test' },
    );
    const raw_conflict = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `40001`.',
      { code: 'P2010', clientVersion: 'test', meta: { code: '40001' } },
    );
    const other_raw_error = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `23505`.',
      { code: 'P2010', clientVersion: 'test', meta: { code: '23505' } },
    );

    expect(isRetryableTransactionError(prisma_conflict)).toBe(true);
    expect(isRetryableTransactionError(raw_conflict)).toBe(true);
    expect(isRetryableTransactionError(other_raw_error)).toBe(false);
  });

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
