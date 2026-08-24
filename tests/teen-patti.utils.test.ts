import { describe, expect, it } from 'vitest';
import { evaluateHand, uniqueHighestIndex, type CardCode } from '@/modules/teen-patti/teen-patti.rank';
import { splitPot } from '@/modules/teen-patti/teen-patti.payout';
import {
  buildTeenPattiBetPlacedPayload,
  buildTeenPattiPreview,
} from '@/modules/teen-patti/teen-patti.public';
import {
  buildLegacyTeenPattiResultAuditHash,
  buildTeenPattiResultCommitment,
} from '@/modules/teen-patti/teen-patti.audit';
import { sha256 } from '@/utils/hash';

const hand = (a: CardCode, b: CardCode, c: CardCode) => evaluateHand([a, b, c]);

describe('teen-patti.rank', () => {
  it('ranks trail above pure sequence', () => {
    const trail = hand('AS', 'AH', 'AD');
    const pure = hand('AS', '2S', '3S');
    expect(trail.category).toBe('trail');
    expect(pure.category).toBe('pure_sequence');
    expect(trail.rank_key > pure.rank_key).toBe(true);
  });

  it('treats A-2-3 as the highest sequence, above A-K-Q', () => {
    const wheel = hand('AS', '2H', '3D');
    const broadway = hand('AS', 'KH', 'QD');
    expect(wheel.category).toBe('sequence');
    expect(broadway.category).toBe('sequence');
    expect(wheel.rank_key > broadway.rank_key).toBe(true);
  });

  it('ranks flush above pair', () => {
    const flush = hand('AS', '9S', '4S');
    const pair = hand('AH', 'AD', 'KS');
    expect(flush.category).toBe('color');
    expect(pair.category).toBe('pair');
    expect(flush.rank_key > pair.rank_key).toBe(true);
  });

  it('returns null when two hands tie for highest', () => {
    const a = hand('AS', 'KH', '9D');
    const b = hand('AH', 'KD', '9C');
    const c = hand('2S', '3H', '7D');
    expect(a.rank_key).toBe(b.rank_key);
    expect(uniqueHighestIndex([a, b, c])).toBeNull();
  });

  it('picks a unique highest hand', () => {
    const winner = hand('AS', 'AH', 'AD');
    const second = hand('KS', 'KH', 'KD');
    const third = hand('2S', '3H', '7D');
    expect(uniqueHighestIndex([second, winner, third])).toBe(1);
  });
});

describe('teen-patti.payout', () => {
  it('splits the pot minus rake proportionally', () => {
    const split = splitPot(2000n, 500, [500n]);
    expect(split.rake).toBe(100n);
    expect(split.distributable).toBe(1900n);
    expect(split.payouts).toEqual([1900n]);
    expect(split.leftover).toBe(0n);
  });

  it('keeps leftover units with the house', () => {
    const split = splitPot(100n, 0, [30n, 40n]);
    expect(split.payouts[0]! + split.payouts[1]! + split.leftover).toBe(100n);
    expect(split.leftover).toBeGreaterThan(0n);
  });

  it('pays nothing when nobody bet the winner', () => {
    const split = splitPot(2000n, 500, []);
    expect(split.payouts).toEqual([]);
    expect(split.leftover).toBe(1900n);
  });
});

describe('teen-patti public projections', () => {
  it('projects exactly one committed card per hand before reveal', () => {
    const preview = buildTeenPattiPreview({
      audit_hash: 'commitment-1',
      hands: [
        {
          option_id: 'hand-a',
          option_code: 'DECK_A',
          cards: ['AS', 'KH', 'QD'],
          category: 'high_card',
          rank_key: '1:14:13:12',
        },
        {
          option_id: 'hand-b',
          option_code: 'DECK_B',
          cards: ['2C', '2H', '9S'],
          category: 'pair',
          rank_key: '2:02:09:00',
        },
        {
          option_id: 'hand-c',
          option_code: 'DECK_C',
          cards: ['TC', 'JC', 'QC'],
          category: 'pure_sequence',
          rank_key: '5:12:00:00',
        },
      ],
    });

    expect(preview).toEqual({
      preview_cards: [
        { option_id: 'hand-a', card: 'AS' },
        { option_id: 'hand-b', card: '2C' },
        { option_id: 'hand-c', card: 'TC' },
      ],
      result_commitment: 'commitment-1',
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('KH');
    expect(serialized).not.toContain('2H');
    expect(serialized).not.toContain('JC');
    expect(serialized).not.toContain('category');
    expect(serialized).not.toContain('rank_key');
    expect(serialized).not.toContain('winner');
  });

  it('builds a wallet-free authoritative public bet event', () => {
    const event = buildTeenPattiBetPlacedPayload(
      {
        id: 'bet-2',
        round_id: 'round-1',
        option_id: 'hand-b',
        amount: 500n,
        accepted_at: new Date('2026-08-23T00:00:02.000Z'),
        user_total_amount: 700n,
        option_total_amount: 1700n,
        bet_count: 2,
        first_bet_at: new Date('2026-08-23T00:00:01.000Z'),
        last_bet_at: new Date('2026-08-23T00:00:02.000Z'),
        player_count: 3,
        round_bet_count: 7,
      },
      {
        user_id: 'user-1',
        display_name: null,
        avatar_url: null,
      },
    );

    expect(event).toEqual({
      bet_id: 'bet-2',
      round_id: 'round-1',
      option_id: 'hand-b',
      user_id: 'user-1',
      display_name: null,
      avatar_url: null,
      amount: '500',
      accepted_at: '2026-08-23T00:00:02.000Z',
      user_total_amount: '700',
      option_total_amount: '1700',
      bet_count: 2,
      first_bet_at: '2026-08-23T00:00:01.000Z',
      last_bet_at: '2026-08-23T00:00:02.000Z',
      player_count: 3,
      round_bet_count: 7,
    });
    expect(event).not.toHaveProperty('wallet_balance');
    expect(event).not.toHaveProperty('client_request_id');
  });

  it('keeps the predeal commitment stable when JSONB reorders object keys', () => {
    const common = {
      round_id: 'round-1',
      config_version_id: 'config-1',
      winning_option_id: 'hand-a',
      algorithm_version: 'teen-patti-predeal-v2',
      entropy_digest: 'entropy',
      generated_at: new Date('2026-08-23T00:00:00.000Z'),
    };
    const before_persistence = [
      {
        option_id: 'hand-a',
        option_code: 'DECK_A',
        cards: ['AS', 'KH', 'QD'],
        category: 'high_card',
        rank_key: '1:14:13:12',
      },
    ];
    const after_jsonb_persistence = [
      {
        cards: ['AS', 'KH', 'QD'],
        category: 'high_card',
        rank_key: '1:14:13:12',
        option_id: 'hand-a',
        option_code: 'DECK_A',
      },
    ];

    expect(
      buildTeenPattiResultCommitment({
        ...common,
        hands: before_persistence,
      }),
    ).toBe(
      buildTeenPattiResultCommitment({
        ...common,
        hands: after_jsonb_persistence,
      }),
    );
  });

  it('reconstructs the original v1 hand field order after JSONB persistence', () => {
    const common = {
      round_id: 'round-legacy',
      config_version_id: 'config-legacy',
      winning_option_id: 'hand-a',
      algorithm_version: 'teen-patti-deal-v1',
      entropy_digest: 'legacy-entropy',
      generated_at: new Date('2026-08-22T00:00:00.000Z'),
    };
    const original_hands = [
      {
        option_id: 'hand-a',
        option_code: 'DECK_A',
        cards: ['AS', 'KH', 'QD'],
        category: 'high_card',
        rank_key: '1:14:13:12',
      },
    ];
    const jsonb_hands = [
      {
        cards: ['AS', 'KH', 'QD'],
        category: 'high_card',
        rank_key: '1:14:13:12',
        option_id: 'hand-a',
        option_code: 'DECK_A',
      },
    ];
    const original_hash = sha256(
      [
        common.round_id,
        common.config_version_id,
        common.winning_option_id,
        common.algorithm_version,
        common.entropy_digest,
        JSON.stringify(original_hands),
        common.generated_at.toISOString(),
      ].join('|'),
    );

    expect(JSON.stringify(jsonb_hands)).not.toBe(JSON.stringify(original_hands));
    expect(buildLegacyTeenPattiResultAuditHash({ ...common, hands: jsonb_hands })).toBe(original_hash);
  });
});
