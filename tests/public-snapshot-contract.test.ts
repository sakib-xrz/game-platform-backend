import { beforeEach, describe, expect, it, vi } from 'vitest';
import GreedyService from '@/modules/greedy/greedy.services';
import TeenPattiService from '@/modules/teen-patti/teen-patti.services';

const mocks = vi.hoisted(() => ({
  gameFindUnique: vi.fn(),
  greedyBetFindMany: vi.fn(),
  greedyBetGroupBy: vi.fn(),
  greedyRoundFindMany: vi.fn(),
  greedyConfigFindMany: vi.fn(),
  greedyResultFindFirst: vi.fn(),
  greedyResultFindUnique: vi.fn(),
  teenPattiBetFindMany: vi.fn(),
  teenPattiBetGroupBy: vi.fn(),
  teenPattiPayoutGroupBy: vi.fn(),
  teenPattiRoundFindMany: vi.fn(),
  teenPattiConfigFindMany: vi.fn(),
  teenPattiResultFindFirst: vi.fn(),
  teenPattiResultFindUnique: vi.fn(),
  teenPattiSnapshotDbTime: vi.fn(),
  prismaTransaction: vi.fn(),
  ensureWallet: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const client = {
    game: { findUnique: mocks.gameFindUnique },
    greedyBet: {
      findMany: mocks.greedyBetFindMany,
      groupBy: mocks.greedyBetGroupBy,
    },
    greedyRound: { findMany: mocks.greedyRoundFindMany },
    greedyConfigVersion: { findMany: mocks.greedyConfigFindMany },
    greedyRoundResult: {
      findFirst: mocks.greedyResultFindFirst,
      findUnique: mocks.greedyResultFindUnique,
    },
    teenPattiBet: {
      findMany: mocks.teenPattiBetFindMany,
      groupBy: mocks.teenPattiBetGroupBy,
    },
    teenPattiUserPayout: { groupBy: mocks.teenPattiPayoutGroupBy },
    teenPattiRound: { findMany: mocks.teenPattiRoundFindMany },
    teenPattiConfigVersion: { findMany: mocks.teenPattiConfigFindMany },
    teenPattiRoundResult: {
      findFirst: mocks.teenPattiResultFindFirst,
      findUnique: mocks.teenPattiResultFindUnique,
    },
    $queryRaw: mocks.teenPattiSnapshotDbTime,
  };
  return {
    default: {
      ...client,
      $transaction: (
        callback: (tx: typeof client) => Promise<unknown>,
        options?: unknown,
      ) => mocks.prismaTransaction(callback, options, client),
    },
  };
});

vi.mock('@/modules/wallet/wallet.services', () => ({
  ensureWallet: mocks.ensureWallet,
  WalletInitializationRequiredError: class extends Error {},
  withWalletInitializationRetry: async <T>(
    _user_id: string,
    operation: () => Promise<T>,
  ) => operation(),
}));

const config = (id: string) => ({
  id,
  version: 1n,
  betting_duration_ms: 15_000,
  lock_duration_ms: 1_500,
  drawing_duration_ms: 3_000,
  result_duration_ms: 5_000,
  min_bet: 10n,
  max_single_bet: 10_000n,
  max_round_bet: 50_000n,
  rake_bps: 500,
  options: [
    {
      id: `${id}-opt`,
      code: 'SHARK',
      name: 'Shark',
      image_url: null,
      display_order: 1,
      payout_numerator: 8n,
      payout_denominator: 1n,
      is_enabled: true,
    },
  ],
  chip_values: [],
});

const round = (id: string, round_config: ReturnType<typeof config>) => ({
  id,
  round_number: 1n,
  status: 'drawing',
  betting_started_at: new Date(0),
  betting_ends_at: new Date(15_000),
  drawing_started_at: new Date(16_500),
  result_reveal_at: new Date(19_500),
  config_version: round_config,
  result: null,
});

describe('public snapshot query contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureWallet.mockResolvedValue({ id: 'wallet', balance: 100n });
    mocks.greedyBetFindMany.mockResolvedValue([]);
    mocks.greedyBetGroupBy.mockResolvedValue([]);
    mocks.greedyRoundFindMany.mockResolvedValue([]);
    mocks.greedyResultFindFirst.mockResolvedValue(null);
    mocks.greedyResultFindUnique.mockResolvedValue(null);
    mocks.teenPattiBetFindMany.mockResolvedValue([]);
    mocks.teenPattiBetGroupBy.mockResolvedValue([]);
    mocks.teenPattiPayoutGroupBy.mockResolvedValue([]);
    mocks.teenPattiRoundFindMany.mockResolvedValue([]);
    mocks.teenPattiResultFindFirst.mockResolvedValue(null);
    mocks.teenPattiResultFindUnique.mockResolvedValue(null);
    mocks.teenPattiSnapshotDbTime.mockResolvedValue([
      { server_time: new Date('2026-08-23T00:00:00.000Z') },
    ]);
    mocks.prismaTransaction.mockImplementation(
      async (
        callback: (tx: unknown) => Promise<unknown>,
        _options: unknown,
        client: unknown,
      ) => callback(client),
    );
  });

  it('filters disabled Greedy options and excludes the current round from history', async () => {
    const active_config = config('greedy-active-config');
    const frozen_config = config('greedy-frozen-config');
    mocks.greedyConfigFindMany.mockResolvedValue([
      active_config,
      frozen_config,
    ]);
    mocks.greedyRoundFindMany.mockResolvedValue([
      { id: 'greedy-round' },
      { id: 'older-greedy-round' },
    ]);
    mocks.gameFindUnique.mockResolvedValue({
      id: 'greedy-game',
      code: 'GREEDY',
      name: 'Greedy',
      status: 'active',
      greedy_runtime_state: {
        status: 'running',
        revision: 1n,
        active_config_version_id: active_config.id,
        current_round: {
          ...round('greedy-round', frozen_config),
          config_version_id: frozen_config.id,
        },
      },
    });
    mocks.greedyBetGroupBy.mockResolvedValue([
      {
        round_id: 'greedy-round',
        option_version_id: 'greedy-frozen-config-opt',
        user_id: 'player-2',
        _sum: { amount: 1500n },
        _count: { _all: 2 },
        _min: { accepted_at: new Date(1_000) },
        _max: { accepted_at: new Date(2_000) },
      },
    ]);

    const snapshot = await GreedyService.getSnapshot('player');

    const game_query = mocks.gameFindUnique.mock.calls[0]![0];
    const runtime_select = game_query.select.greedy_runtime_state.select;
    expect(runtime_select.active_config_version_id).toBe(true);
    expect(runtime_select.current_round.select.config_version_id).toBe(true);
    expect(
      mocks.greedyConfigFindMany.mock.calls[0]![0].select.options.where,
    ).toEqual({ is_enabled: true });
    expect(snapshot.active_config.id).toBe(active_config.id);
    expect(snapshot.round?.config_version_id).toBe(frozen_config.id);
    expect(snapshot.active_config.options[0]?.payout_multiplier).toBe('8x');
    expect(snapshot.round?.options[0]?.payout_multiplier).toBe('8x');
    expect(snapshot.round?.bettors).toEqual([
      {
        round_id: 'greedy-round',
        option_id: 'greedy-frozen-config-opt',
        user_id: 'player-2',
        display_name: null,
        avatar_url: null,
        total_amount: '1500',
        bet_count: 2,
        first_bet_at: new Date(1_000).toISOString(),
        last_bet_at: new Date(2_000).toISOString(),
      },
    ]);
    expect(snapshot.recent_history.map((item) => item.id)).toEqual([
      'older-greedy-round',
    ]);
    expect(mocks.greedyRoundFindMany.mock.calls[0]![0].take).toBe(21);
  });

  it('adds the aggregate Top 3 contract only to a revealed Greedy result', async () => {
    const active_config = config('greedy-active-config');
    const frozen_config = config('greedy-frozen-config');
    const winning_option = frozen_config.options[0]!;
    const current_result = {
      id: 'result-1',
      round_id: 'greedy-round',
      algorithm_version: 'test-v1',
      generated_at: new Date(10_000),
      revealed_at: new Date(20_000),
      winning_option,
    };
    mocks.greedyConfigFindMany.mockResolvedValue([
      active_config,
      frozen_config,
    ]);
    mocks.greedyResultFindFirst.mockResolvedValue(current_result);
    mocks.gameFindUnique.mockResolvedValue({
      id: 'greedy-game',
      code: 'GREEDY',
      name: 'Greedy',
      status: 'active',
      greedy_runtime_state: {
        status: 'running',
        revision: 1n,
        active_config_version_id: active_config.id,
        current_round: {
          ...round('greedy-round', frozen_config),
          status: 'result_revealed',
          config_version_id: frozen_config.id,
        },
      },
    });
    mocks.greedyBetGroupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          round_id: 'greedy-round',
          user_id: 'nasim',
          _sum: { amount: 3000n },
          _count: { _all: 2 },
          _min: { accepted_at: new Date(1_000) },
        },
      ]);

    const snapshot = await GreedyService.getSnapshot('player');

    expect(snapshot.round?.result?.top_winners).toEqual([
      {
        rank: 1,
        user_id: 'nasim',
        display_name: null,
        avatar_url: null,
        winning_stake: '3000',
        bet_count: 2,
        total_payout: '24000',
        first_bet_at: new Date(1_000).toISOString(),
      },
    ]);
  });

  it('filters disabled Teen Patti options and excludes the current round from history', async () => {
    const active_config = config('teen-active-config');
    const frozen_config = config('teen-frozen-config');
    frozen_config.result_duration_ms = 1_000;
    mocks.teenPattiConfigFindMany.mockResolvedValue([
      active_config,
      frozen_config,
    ]);
    mocks.teenPattiRoundFindMany.mockResolvedValue([
      { id: 'teen-round' },
      { id: 'older-teen-round' },
      { id: 'empty-teen-round' },
    ]);
    mocks.teenPattiBetGroupBy
      .mockResolvedValueOnce([
        {
          round_id: 'teen-round',
          option_version_id: 'teen-frozen-config-opt',
          user_id: 'player-2',
          _sum: { amount: 700n },
          _count: { _all: 3 },
          _min: { accepted_at: new Date(1_000) },
          _max: { accepted_at: new Date(3_000) },
        },
        {
          round_id: 'teen-round',
          option_version_id: 'teen-frozen-config-opt',
          user_id: 'player-3',
          _sum: { amount: 500n },
          _count: { _all: 1 },
          _min: { accepted_at: new Date(2_000) },
          _max: { accepted_at: new Date(2_000) },
        },
      ])
      .mockResolvedValueOnce([
        { round_id: 'older-teen-round', _sum: { amount: 4_200n } },
      ]);
    mocks.teenPattiPayoutGroupBy.mockResolvedValue([
      { round_id: 'older-teen-round', _sum: { total_payout: 3_800n } },
    ]);
    mocks.teenPattiBetFindMany.mockResolvedValue([
      {
        id: 'my-bet-1',
        round_id: 'teen-round',
        amount: 500n,
        client_request_id: 'request-recovered-1',
        accepted_at: new Date(2_500),
        option: frozen_config.options[0],
        settlement: null,
      },
    ]);
    mocks.teenPattiResultFindFirst.mockResolvedValue({
      id: 'predeal-result',
      round_id: 'teen-round',
      algorithm_version: 'teen-patti-deal-v1',
      config_version_id: frozen_config.id,
      entropy_digest: 'hidden-entropy',
      audit_hash: 'committed-result-hash',
      generated_at: new Date(0),
      revealed_at: null,
      deal_attempt_count: 1,
      hands: [
        {
          option_id: 'teen-frozen-config-opt',
          option_code: 'DECK_A',
          cards: ['AS', 'KH', 'QD'],
          category: 'high_card',
          rank_key: '1:14:13:12',
        },
        {
          option_id: 'deck-b',
          option_code: 'DECK_B',
          cards: ['2C', '2H', '9S'],
          category: 'pair',
          rank_key: '2:02:09:00',
        },
        {
          option_id: 'deck-c',
          option_code: 'DECK_C',
          cards: ['TC', 'JC', 'QC'],
          category: 'pure_sequence',
          rank_key: '5:12:00:00',
        },
      ],
      winning_option: frozen_config.options[0],
    });
    mocks.gameFindUnique.mockResolvedValue({
      id: 'teen-game',
      code: 'TEEN_PATTI',
      name: 'Teen Patti',
      status: 'active',
      teen_patti_runtime_state: {
        status: 'running',
        revision: 1n,
        active_config_version_id: active_config.id,
        current_round: {
          ...round('teen-round', frozen_config),
          status: 'betting_open',
          config_version_id: frozen_config.id,
        },
      },
    });

    const snapshot = await TeenPattiService.getSnapshot('player');

    const game_query = mocks.gameFindUnique.mock.calls[0]![0];
    const runtime_select = game_query.select.teen_patti_runtime_state.select;
    expect(runtime_select.active_config_version_id).toBe(true);
    expect(runtime_select.current_round.select.config_version_id).toBe(true);
    expect(
      mocks.teenPattiConfigFindMany.mock.calls[0]![0].select.options.where,
    ).toEqual({ is_enabled: true });
    expect(snapshot.active_config.id).toBe(active_config.id);
    expect(snapshot.round?.config_version_id).toBe(frozen_config.id);
    expect(snapshot.round?.result_duration_ms).toBe(5_000);
    expect(snapshot.server_time).toEqual(
      new Date('2026-08-23T00:00:00.000Z'),
    );
    expect(mocks.prismaTransaction.mock.calls.at(-1)?.[1]).toEqual({
      isolationLevel: 'RepeatableRead',
    });
    expect(snapshot.player).toEqual({
      user_id: 'player',
      display_name: null,
      avatar_url: null,
    });
    expect(snapshot.round?.bettors).toEqual([
      {
        round_id: 'teen-round',
        option_id: 'teen-frozen-config-opt',
        user_id: 'player-2',
        display_name: null,
        avatar_url: null,
        total_amount: '700',
        bet_count: 3,
        first_bet_at: new Date(1_000).toISOString(),
        last_bet_at: new Date(3_000).toISOString(),
      },
      {
        round_id: 'teen-round',
        option_id: 'teen-frozen-config-opt',
        user_id: 'player-3',
        display_name: null,
        avatar_url: null,
        total_amount: '500',
        bet_count: 1,
        first_bet_at: new Date(2_000).toISOString(),
        last_bet_at: new Date(2_000).toISOString(),
      },
    ]);
    expect(snapshot.round?.player_count).toBe(2);
    expect(snapshot.round?.round_bet_count).toBe(4);
    expect(snapshot.round?.option_pot_totals).toEqual([
      { option_id: 'teen-frozen-config-opt', total_amount: '1200' },
    ]);
    expect(snapshot.round?.preview_cards).toEqual([
      { option_id: 'teen-frozen-config-opt', card: 'AS' },
      { option_id: 'deck-b', card: '2C' },
      { option_id: 'deck-c', card: 'TC' },
    ]);
    expect(snapshot.round?.result_commitment).toBe('committed-result-hash');
    expect(snapshot.round?.result).toBeNull();
    expect(snapshot.round?.preview_cards).not.toContainEqual(
      expect.objectContaining({ card: 'KH' }),
    );
    expect(snapshot.recent_history.map((item) => item.id)).toEqual([
      'older-teen-round',
      'empty-teen-round',
    ]);
    expect(snapshot.recent_history[0]).toMatchObject({
      total_bet_amount: '4200',
      total_payout_amount: '3800',
    });
    expect(snapshot.recent_history[1]).toMatchObject({
      total_bet_amount: '0',
      total_payout_amount: '0',
    });
    expect(snapshot.my_bets[0]?.client_request_id).toBe(
      'request-recovered-1',
    );
    expect(
      mocks.teenPattiBetFindMany.mock.calls[0]![0].select.client_request_id,
    ).toBe(true);
    expect(mocks.teenPattiRoundFindMany.mock.calls[0]![0].take).toBe(21);
  });
});
