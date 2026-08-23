import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminRole } from '@/generated/prisma/client';
import TeenPattiAdminOpsService from '@/modules/game-admin/teen-patti-admin-ops.services';

const mocks = vi.hoisted(() => ({
  gameFindUnique: vi.fn(),
  roundFindFirst: vi.fn(),
  betAggregate: vi.fn(),
  payoutAggregate: vi.fn(),
  refundAggregate: vi.fn(),
  settlementGroupBy: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    game: { findUnique: mocks.gameFindUnique },
    teenPattiRound: { findFirst: mocks.roundFindFirst },
    teenPattiBet: { aggregate: mocks.betAggregate },
    teenPattiUserPayout: { aggregate: mocks.payoutAggregate },
    teenPattiUserRefund: { aggregate: mocks.refundAggregate },
    teenPattiBetSettlement: { groupBy: mocks.settlementGroupBy },
  },
}));

const hidden_result = {
  id: 'result-1',
  round_id: 'round-1',
  winning_option_version_id: 'hand-c',
  algorithm_version: 'teen-patti-deal-v1',
  config_version_id: 'config-1',
  entropy_digest: 'must-not-leak-before-reveal',
  audit_hash: 'commitment',
  deal_attempt_count: 1,
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
  generated_at: new Date('2026-08-23T00:00:00.000Z'),
  revealed_at: null,
  winning_option: { id: 'hand-c', code: 'DECK_C', name: 'Hand 3' },
};

describe('Teen Patti predeal admin security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gameFindUnique.mockResolvedValue({ id: 'teen-game' });
    mocks.roundFindFirst.mockResolvedValue({
      id: 'round-1',
      game_id: 'teen-game',
      status: 'betting_open',
      result: hidden_result,
    });
    mocks.betAggregate.mockResolvedValue({
      _sum: { amount: 0n },
      _count: { _all: 0 },
    });
    mocks.payoutAggregate.mockResolvedValue({
      _sum: { total_payout: 0n, total_winning_stake: 0n },
      _count: { _all: 0 },
    });
    mocks.refundAggregate.mockResolvedValue({
      _sum: { total_bet_amount: 0n },
      _count: { _all: 0 },
    });
    mocks.settlementGroupBy.mockResolvedValue([]);
  });

  it('masks the full predealt result in admin round detail before reveal', async () => {
    const response = await TeenPattiAdminOpsService.getRound(
      'round-1',
      AdminRole.auditor,
    );

    expect(response.round.result).toBeNull();
    expect(JSON.stringify(response.round)).not.toContain('hand-c');
    expect(JSON.stringify(response.round)).not.toContain('KH');
  });

  it('blocks result verification before the public reveal state', async () => {
    await expect(
      TeenPattiAdminOpsService.verifyRoundResult(
        'round-1',
        AdminRole.auditor,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Round result is hidden until public reveal',
    });
  });
});
