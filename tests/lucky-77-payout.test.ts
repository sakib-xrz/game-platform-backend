import { describe, expect, it } from 'vitest';
import { LUCKY_77_SLOT_MAP } from '@/modules/lucky-77/lucky-77.constant';
import {
  buildLucky77BetPlacedPayload,
  buildLucky77TopWinners,
  calculatePayout,
  compareLucky77WinnerRankings,
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

  it('builds the public live-bet payload without wallet or request data', () => {
    const payload = buildLucky77BetPlacedPayload(
      {
        id: 'bet-1',
        round_id: 'round-1',
        option_id: 'apple-option',
        amount: 100n,
        accepted_at: new Date(2_000),
        total_amount: 300n,
        bet_count: 2,
        first_bet_at: new Date(1_000),
        last_bet_at: new Date(2_000),
      },
      { user_id: 'player-1', display_name: 'Player 1', avatar_url: null },
    );

    expect(payload).toEqual({
      bet_id: 'bet-1',
      round_id: 'round-1',
      option_id: 'apple-option',
      amount: '100',
      accepted_at: new Date(2_000).toISOString(),
      total_amount: '300',
      bet_count: 2,
      first_bet_at: new Date(1_000).toISOString(),
      last_bet_at: new Date(2_000).toISOString(),
      bettor: {
        user_id: 'player-1',
        display_name: 'Player 1',
        avatar_url: null,
      },
    });
    expect(payload).not.toHaveProperty('wallet_balance');
    expect(payload).not.toHaveProperty('client_request_id');
  });

  it('ranks only the Top 3 aggregate Lucky 77 winners deterministically', () => {
    const winners = buildLucky77TopWinners(
      [
        { user_id: 'later', amount: 100n, accepted_at: new Date(3_000) },
        { user_id: 'z-user', amount: 100n, accepted_at: new Date(1_000) },
        { user_id: 'a-user', amount: 100n, accepted_at: new Date(1_000) },
        { user_id: 'largest', amount: 200n, accepted_at: new Date(4_000) },
      ],
      2n,
      1n,
    );

    expect(winners.map((winner) => winner.user_id)).toEqual([
      'largest',
      'a-user',
      'z-user',
    ]);
    expect(winners.map((winner) => winner.total_payout)).toEqual([
      '400',
      '200',
      '200',
    ]);
    expect(winners.map((winner) => winner.rank)).toEqual([1, 2, 3]);
  });

  it('exports the gross-payout comparator used by the Lucky 77 podium', () => {
    const common = {
      winning_stake: 10n,
      bet_count: 1,
      first_bet_at: new Date(1_000),
      total_payout: 20n,
    };
    expect(
      compareLucky77WinnerRankings(
        { ...common, user_id: 'a', total_payout: 30n },
        { ...common, user_id: 'b' },
      ),
    ).toBe(-1);
    expect(
      compareLucky77WinnerRankings(
        { ...common, user_id: 'a' },
        { ...common, user_id: 'b' },
      ),
    ).toBe(-1);
  });
});
