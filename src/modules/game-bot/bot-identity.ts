import { GameBotStatus } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';

const BOT_CACHE_KEY = 'game-bots:active-ids';
const BOT_PROFILE_CACHE_KEY = 'game-bots:profiles';
const CACHE_TTL_SECONDS = 60;

type BotRecord = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  persona_seed: number;
  game_code: string;
};

let memory_loaded_at = 0;
let memory_bot_records: BotRecord[] = [];

const loadActiveBots = async () => {
  const now = Date.now();
  if (now - memory_loaded_at < CACHE_TTL_SECONDS * 1000 && memory_bot_records.length > 0) {
    return {
      ids: new Set(memory_bot_records.map((bot) => bot.id)),
      profiles: new Map(
        memory_bot_records.map((bot) => [bot.id, { display_name: bot.display_name, avatar_url: bot.avatar_url }]),
      ),
      records: memory_bot_records,
    };
  }

  if (redisClient.isReady) {
    const cached_ids = await redisClient.sMembers(BOT_CACHE_KEY);
    const cached_profiles = await redisClient.hGetAll(BOT_PROFILE_CACHE_KEY);
    if (cached_ids.length > 0) {
      const bots = prisma.gameBot
        ? await prisma.gameBot.findMany({
            where: { id: { in: cached_ids }, status: GameBotStatus.active },
            select: { id: true, display_name: true, avatar_url: true, persona_seed: true, game_code: true },
          })
        : [];
      memory_bot_records = bots;
      memory_loaded_at = now;
      return {
        ids: new Set(bots.map((bot) => bot.id)),
        profiles: new Map(
          bots.map((bot) => [bot.id, { display_name: bot.display_name, avatar_url: bot.avatar_url }]),
        ),
        records: bots,
      };
    }
  }

  const bots = prisma.gameBot
    ? await prisma.gameBot.findMany({
        where: { status: GameBotStatus.active },
        select: { id: true, display_name: true, avatar_url: true, persona_seed: true, game_code: true },
      })
    : [];
  memory_bot_records = bots;
  memory_loaded_at = now;

  if (redisClient.isReady) {
    await redisClient.del(BOT_CACHE_KEY);
    await redisClient.del(BOT_PROFILE_CACHE_KEY);
    if (bots.length) {
      await redisClient.sAdd(BOT_CACHE_KEY, bots.map((bot) => bot.id));
      await redisClient.expire(BOT_CACHE_KEY, CACHE_TTL_SECONDS);
      const profile_entries = Object.fromEntries(
        bots.map((bot) => [
          bot.id,
          JSON.stringify({ display_name: bot.display_name, avatar_url: bot.avatar_url }),
        ]),
      );
      await redisClient.hSet(BOT_PROFILE_CACHE_KEY, profile_entries);
      await redisClient.expire(BOT_PROFILE_CACHE_KEY, CACHE_TTL_SECONDS);
    }
  }

  return {
    ids: new Set(bots.map((bot) => bot.id)),
    profiles: new Map(
      bots.map((bot) => [bot.id, { display_name: bot.display_name, avatar_url: bot.avatar_url }]),
    ),
    records: bots,
  };
};

export const refreshBotIdentityCache = async (): Promise<void> => {
  memory_loaded_at = 0;
  await loadActiveBots();
};

export const isBotUserId = async (user_id: string): Promise<boolean> => {
  const { ids } = await loadActiveBots();
  return ids.has(user_id);
};

export const isBotUserIdSync = (user_id: string): boolean =>
  memory_bot_records.some((bot) => bot.id === user_id);

export const getActiveBotIds = async (): Promise<string[]> => {
  const { ids } = await loadActiveBots();
  return [...ids];
};

export const getActiveBots = async (game_code?: string) => {
  const { records } = await loadActiveBots();
  if (!game_code) return records;
  return records.filter((bot) => bot.game_code === game_code);
};

export type GamePublicIdentity = {
  display_name: string | null;
  avatar_url: string | null;
};

export const resolveGameIdentity = async (user_id: string): Promise<GamePublicIdentity> => {
  const { profiles } = await loadActiveBots();
  const bot = profiles.get(user_id);
  if (bot) {
    return { display_name: bot.display_name, avatar_url: bot.avatar_url };
  }
  return {
    display_name: `Player ${user_id.slice(-6)}`,
    avatar_url: null,
  };
};

export const resolveGameIdentities = async (
  user_ids: string[],
): Promise<Map<string, GamePublicIdentity>> => {
  const unique_ids = [...new Set(user_ids)];
  const { profiles } = await loadActiveBots();
  return new Map(
    unique_ids.map((user_id) => {
      const bot = profiles.get(user_id);
      if (bot) {
        return [user_id, { display_name: bot.display_name, avatar_url: bot.avatar_url }];
      }
      return [user_id, { display_name: `Player ${user_id.slice(-6)}`, avatar_url: null }];
    }),
  );
};

export const resolveGameIdentitySync = (user_id: string): GamePublicIdentity => {
  const bot = memory_bot_records.find((record) => record.id === user_id);
  if (bot) {
    return { display_name: bot.display_name, avatar_url: bot.avatar_url };
  }
  return {
    display_name: `Player ${user_id.slice(-6)}`,
    avatar_url: null,
  };
};

export const attachUserId = (
  user_id: string,
  identity: GamePublicIdentity,
): GreedyPublicIdentityLike => ({
  user_id,
  display_name: identity.display_name,
  avatar_url: identity.avatar_url,
});

export type GreedyPublicIdentityLike = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
};
