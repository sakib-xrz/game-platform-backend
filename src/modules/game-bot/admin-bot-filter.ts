import { Prisma } from '@/generated/prisma/client';
import { getActiveBotIds } from './bot-identity';

export const humanOnlyBetUserFilter = async (
  explicit_user_id?: string,
): Promise<string | { notIn: string[] } | undefined> => {
  if (explicit_user_id) return explicit_user_id;
  const bot_ids = await getActiveBotIds();
  if (!bot_ids.length) return undefined;
  return { notIn: bot_ids };
};

export const buildExcludeBotsSql = (bot_ids: string[]): Prisma.Sql => {
  if (!bot_ids.length) return Prisma.sql`TRUE`;
  return Prisma.sql`user_id NOT IN (${Prisma.join(bot_ids)})`;
};
