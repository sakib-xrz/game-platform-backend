import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyLeaderboardService } from '@/modules/leaderboard/daily-leaderboard.service';
import {
  formatDisplayName,
  formatLeaderboardDate,
  getLeaderboardDayWindow,
  leaderboardCacheKey,
  mapAggregateRow,
  netProfitOf,
  rankByNetProfit,
} from '@/modules/leaderboard/daily-leaderboard.helpers';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  platformUserFindMany: vi.fn(),
  getActiveBotIds: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisIsReady: false,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: mocks.queryRaw,
    platformUser: {
      findMany: mocks.platformUserFindMany,
    },
  },
}));

vi.mock('@/modules/game-bot/bot-identity', () => ({
  getActiveBotIds: mocks.getActiveBotIds,
}));

vi.mock('@/infrastructure/redis/redis.client', () => ({
  redisClient: {
    get isReady() {
      return mocks.redisIsReady;
    },
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

describe('daily-leaderboard.helpers', () => {
  it('computes Asia/Dhaka day windows for today and yesterday', () => {
    // 2026-11-17 22:00 UTC == 2026-11-18 04:00 Asia/Dhaka
    const now = new Date('2026-11-17T22:00:00.000Z');
    const today = getLeaderboardDayWindow('today', now);
    expect(today.date).toBe('2026-11-18');
    expect(today.from.toISOString()).toBe('2026-11-17T18:00:00.000Z');
    expect(today.to.toISOString()).toBe('2026-11-18T18:00:00.000Z');
    expect(today.resetsAt.toISOString()).toBe('2026-11-18T18:00:00.000Z');

    const yesterday = getLeaderboardDayWindow('yesterday', now);
    expect(yesterday.date).toBe('2026-11-17');
    expect(yesterday.from.toISOString()).toBe('2026-11-16T18:00:00.000Z');
    expect(yesterday.to.toISOString()).toBe('2026-11-17T18:00:00.000Z');
  });

  it('formats display names and cache keys', () => {
    expect(formatDisplayName('usr_abcd1234', '  Rifat  ')).toBe('Rifat');
    expect(formatDisplayName('usr_abcd1234')).toBe('Player abcd');
    expect(formatLeaderboardDate(2026, 10, 17)).toBe('2026-11-17');
    expect(leaderboardCacheKey('greedy', 'today', '2026-11-17')).toBe(
      'leaderboard:v1:greedy:today:2026-11-17',
    );
  });

  it('ranks by net profit then payout then user id with no seed padding', () => {
    const ranked = rankByNetProfit([
      mapAggregateRow({
        user_id: 'b',
        total_bet: '100',
        total_payout: '250',
        total_refund: '0',
        win_count: 2,
      }),
      mapAggregateRow({
        user_id: 'a',
        total_bet: '100',
        total_payout: '250',
        total_refund: '0',
        win_count: 1,
      }),
      mapAggregateRow({
        user_id: 'c',
        total_bet: '50',
        total_payout: '300',
        total_refund: '0',
        win_count: 3,
      }),
    ]);
    expect(ranked.map((row) => row.userId)).toEqual(['c', 'a', 'b']);
    expect(netProfitOf({ totalPayout: 300n, totalRefund: 20n, totalBet: 100n })).toBe(220n);
  });
});

describe('DailyLeaderboardService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisIsReady = false;
    mocks.getActiveBotIds.mockResolvedValue(['bot-1']);
    mocks.platformUserFindMany.mockResolvedValue([]);
  });

  it('returns real profitable winners only without seed padding', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          user_id: 'usr_real_champion',
          total_bet: '100000',
          total_payout: '500000',
          total_refund: '0',
          win_count: 12,
        },
      ])
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([
        {
          user_id: 'usr_real_champion',
          total_bet: '100000',
          total_payout: '500000',
          total_refund: '0',
          win_count: 12,
        },
      ]);

    mocks.platformUserFindMany.mockResolvedValue([
      {
        id: 'usr_real_champion',
        external_user_id: 'usr_real_champion',
        display_name: 'Mahmudul Hasan',
        photo_url: 'https://example.com/avatar.jpg',
      },
    ]);

    const result = await DailyLeaderboardService.getDailyLeaderboard(
      'greedy',
      'today',
      'usr_real_champion',
    );

    expect(result.gameCode).toBe('greedy');
    expect(result.period).toBe('today');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      userId: 'usr_real_champion',
      displayName: 'Mahmudul Hasan',
      netProfit: '400000',
      totalPayout: '500000',
      winCount: 12,
      rank: 1,
      isCurrentUser: true,
    });
    expect(result.currentUser).toMatchObject({
      rank: 1,
      totalBet: '100000',
      netProfit: '400000',
    });
    expect(result.totalParticipants).toBe(1);
    expect(result.entries.some((entry) => entry.userId.startsWith('seed_'))).toBe(
      false,
    );
  });

  it('marks callers outside the board with a true rank or unranked', async () => {
    mocks.queryRaw
      // top board
      .mockResolvedValueOnce([
        {
          user_id: 'usr_top',
          total_bet: '10',
          total_payout: '1000',
          total_refund: '0',
          win_count: 5,
        },
      ])
      // participant count
      .mockResolvedValueOnce([{ total: '3' }])
      // caller aggregate
      .mockResolvedValueOnce([
        {
          user_id: 'usr_me',
          total_bet: '200',
          total_payout: '250',
          total_refund: '0',
          win_count: 1,
        },
      ])
      // players ahead
      .mockResolvedValueOnce([{ higher: '1' }]);

    const profitable = await DailyLeaderboardService.getDailyLeaderboard(
      'greedy',
      'today',
      'usr_me',
    );
    expect(profitable.currentUser).toMatchObject({
      userId: 'usr_me',
      rank: 2,
      netProfit: '50',
      totalBet: '200',
      totalPayout: '250',
    });

    vi.clearAllMocks();
    mocks.getActiveBotIds.mockResolvedValue([]);
    mocks.platformUserFindMany.mockResolvedValue([]);
    mocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: '0' }])
      .mockResolvedValueOnce([
        {
          user_id: 'usr_me',
          total_bet: '500',
          total_payout: '100',
          total_refund: '0',
          win_count: 0,
        },
      ]);

    const unranked = await DailyLeaderboardService.getDailyLeaderboard(
      'greedy',
      'today',
      'usr_me',
    );
    expect(unranked.currentUser?.rank).toBeNull();
    expect(unranked.currentUser?.netProfit).toBe('-400');
  });

  it('supports yesterday and all four game codes', async () => {
    for (const gameCode of [
      'greedy',
      'greedy-classic',
      'teen-patti',
      'lucky-77',
    ] as const) {
      mocks.queryRaw.mockReset();
      mocks.queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);
      const result = await DailyLeaderboardService.getDailyLeaderboard(
        gameCode,
        'yesterday',
      );
      expect(result.gameCode).toBe(gameCode);
      expect(result.period).toBe('yesterday');
      expect(result.entries).toEqual([]);
      expect(result.currentUser).toBeNull();
    }
  });

  it('excludes bots via getActiveBotIds and never invents mock winners', async () => {
    mocks.getActiveBotIds.mockResolvedValue(['bot-alpha', 'bot-beta']);
    mocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: '0' }]);

    const result = await DailyLeaderboardService.getDailyLeaderboard('lucky-77');
    expect(mocks.getActiveBotIds).toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.totalParticipants).toBe(0);
  });
});
