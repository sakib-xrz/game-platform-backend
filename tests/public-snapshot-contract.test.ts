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
  teenPattiRoundFindMany: vi.fn(),
  teenPattiConfigFindMany: vi.fn(),
  teenPattiResultFindFirst: vi.fn(),
  teenPattiResultFindUnique: vi.fn(),
  ensureWallet: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
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
    teenPattiRound: { findMany: mocks.teenPattiRoundFindMany },
    teenPattiConfigVersion: { findMany: mocks.teenPattiConfigFindMany },
    teenPattiRoundResult: {
      findFirst: mocks.teenPattiResultFindFirst,
      findUnique: mocks.teenPattiResultFindUnique,
    },
  },
}));

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
    mocks.teenPattiRoundFindMany.mockResolvedValue([]);
    mocks.teenPattiResultFindFirst.mockResolvedValue(null);
    mocks.teenPattiResultFindUnique.mockResolvedValue(null);
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
    mocks.teenPattiConfigFindMany.mockResolvedValue([
      active_config,
      frozen_config,
    ]);
    mocks.teenPattiRoundFindMany.mockResolvedValue([
      { id: 'teen-round' },
      { id: 'older-teen-round' },
    ]);
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
    expect(snapshot.recent_history.map((item) => item.id)).toEqual([
      'older-teen-round',
    ]);
    expect(mocks.teenPattiRoundFindMany.mock.calls[0]![0].take).toBe(21);
  });
});
