import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isBotUserIdSync,
  refreshBotIdentityCache,
  resolveGameIdentitySync,
} from '@/modules/game-bot/bot-identity';

const mocks = vi.hoisted(() => ({
  gameBotFindMany: vi.fn(),
  isReady: false,
  sMembers: vi.fn(),
  hGetAll: vi.fn(),
  del: vi.fn(),
  sAdd: vi.fn(),
  expire: vi.fn(),
  hSet: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    gameBot: {
      findMany: mocks.gameBotFindMany,
    },
  },
}));

vi.mock('@/infrastructure/redis/redis.client', () => ({
  redisClient: {
    get isReady() {
      return mocks.isReady;
    },
    sMembers: mocks.sMembers,
    hGetAll: mocks.hGetAll,
    del: mocks.del,
    sAdd: mocks.sAdd,
    expire: mocks.expire,
    hSet: mocks.hSet,
  },
}));

describe('bot-identity', () => {
  beforeEach(async () => {
    mocks.gameBotFindMany.mockReset();
    mocks.sMembers.mockReset();
    mocks.hGetAll.mockReset();
    mocks.del.mockReset();
    mocks.sAdd.mockReset();
    mocks.expire.mockReset();
    mocks.hSet.mockReset();
    mocks.isReady = false;
    mocks.gameBotFindMany.mockResolvedValue([]);
    await refreshBotIdentityCache();
  });

  it('masks human user ids in public snapshots', () => {
    expect(resolveGameIdentitySync('player-abc123')).toEqual({
      display_name: 'Player abc123',
      avatar_url: null,
    });
  });

  it('does not treat arbitrary ids as bots without cache data', () => {
    expect(isBotUserIdSync('gbot01aarav')).toBe(false);
  });

  it('marks seeded bots as bots after refreshBotIdentityCache', async () => {
    mocks.gameBotFindMany.mockResolvedValue([
      {
        id: 'gbot01aarav',
        display_name: 'Aarav',
        avatar_url: null,
        persona_seed: 1,
      },
    ]);

    await refreshBotIdentityCache();

    expect(isBotUserIdSync('gbot01aarav')).toBe(true);
    expect(isBotUserIdSync('human-player')).toBe(false);
    expect(resolveGameIdentitySync('gbot01aarav')).toEqual({
      display_name: 'Aarav',
      avatar_url: null,
    });
  });
});
