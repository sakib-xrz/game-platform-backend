import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import {
  allocateGreedyWinningBetPayouts,
  buildGreedyBetPlacedPayload,
  buildGreedyTopWinners,
  calculatePayout,
  compareGreedyWinnerRankings,
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

  it('builds the public bet animation event without private wallet/request data', () => {
    const payload = buildGreedyBetPlacedPayload(
      {
        id: 'bet-1',
        round_id: 'round-1',
        option_id: 'option-1',
        amount: 1000n,
        accepted_at: new Date(1_000),
        total_amount: 3000n,
        bet_count: 2,
        first_bet_at: new Date(500),
        last_bet_at: new Date(1_000),
      },
      'nasim',
    );

    expect(payload).toEqual({
      bet_id: 'bet-1',
      round_id: 'round-1',
      option_id: 'option-1',
      amount: '1000',
      accepted_at: new Date(1_000).toISOString(),
      total_amount: '3000',
      bet_count: 2,
      first_bet_at: new Date(500).toISOString(),
      last_bet_at: new Date(1_000).toISOString(),
      bettor: {
        user_id: 'nasim',
        display_name: null,
        avatar_url: null,
      },
    });
    expect(payload).not.toHaveProperty('wallet_balance');
    expect(payload).not.toHaveProperty('client_request_id');
  });

  it('aggregates a user winning stake before applying a fractional multiplier', () => {
    const winners = buildGreedyTopWinners(
      [
        { user_id: 'nasim', amount: 1n, accepted_at: new Date(2_000) },
        { user_id: 'nasim', amount: 1n, accepted_at: new Date(1_000) },
        { user_id: 'other', amount: 1n, accepted_at: new Date(500) },
      ],
      3n,
      2n,
    );

    expect(winners).toEqual([
      {
        rank: 1,
        user_id: 'nasim',
        display_name: null,
        avatar_url: null,
        winning_stake: '2',
        bet_count: 2,
        total_payout: '3',
        first_bet_at: new Date(1_000).toISOString(),
      },
      {
        rank: 2,
        user_id: 'other',
        display_name: null,
        avatar_url: null,
        winning_stake: '1',
        bet_count: 1,
        total_payout: '1',
        first_bet_at: new Date(500).toISOString(),
      },
    ]);
  });

  it('limits the podium to real winners and applies both deterministic tie-breaks', () => {
    const winners = buildGreedyTopWinners(
      [
        { user_id: 'later', amount: 100n, accepted_at: new Date(3_000) },
        { user_id: 'z-user', amount: 100n, accepted_at: new Date(1_000) },
        { user_id: 'a-user', amount: 100n, accepted_at: new Date(1_000) },
        { user_id: 'largest', amount: 200n, accepted_at: new Date(4_000) },
      ],
      5n,
      1n,
    );

    expect(winners.map((winner) => winner.user_id)).toEqual([
      'largest',
      'a-user',
      'z-user',
    ]);
    expect(winners.map((winner) => winner.rank)).toEqual([1, 2, 3]);
  });

  it('exports the gross-payout comparator used by the leaderboard', () => {
    const common = {
      winning_stake: 10n,
      bet_count: 1,
      first_bet_at: new Date(1_000),
      total_payout: 50n,
    };
    expect(
      compareGreedyWinnerRankings(
        { ...common, user_id: 'a', total_payout: 100n },
        { ...common, user_id: 'b' },
      ),
    ).toBe(-1);
    expect(
      compareGreedyWinnerRankings(
        { ...common, user_id: 'a' },
        { ...common, user_id: 'b' },
      ),
    ).toBe(-1);
  });

  it('allocates fractional rounding while settlement rows still sum to wallet credit', () => {
    const allocation = allocateGreedyWinningBetPayouts(
      [
        { id: 'later', amount: 1n, accepted_at: new Date(2_000) },
        { id: 'earlier', amount: 1n, accepted_at: new Date(1_000) },
      ],
      3n,
      2n,
    );

    expect(allocation.total_winning_stake).toBe(2n);
    expect(allocation.total_payout).toBe(3n);
    expect(allocation.payout_by_bet.get('earlier')).toBe(2n);
    expect(allocation.payout_by_bet.get('later')).toBe(1n);
    expect(
      [...allocation.payout_by_bet.values()].reduce(
        (total, payout) => total + payout,
        0n,
      ),
    ).toBe(allocation.total_payout);
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
