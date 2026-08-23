import prisma from '@/lib/prisma';
import { getActiveBotIds } from './bot-identity';
import type { BiasedBetStake } from './biased-outcome';

const mapRoundBets = async (
  bets: Array<{ user_id: string; option_version_id: string; amount: bigint }>,
): Promise<BiasedBetStake[]> => {
  const bot_ids = new Set(await getActiveBotIds());
  return bets.map((bet) => ({
    user_id: bet.user_id,
    option_id: bet.option_version_id,
    amount: bet.amount,
    is_bot: bot_ids.has(bet.user_id),
  }));
};

export const loadGreedyRoundBets = async (round_id: string) =>
  mapRoundBets(
    await prisma.greedyBet.findMany({
      where: { round_id },
      select: { user_id: true, option_version_id: true, amount: true },
    }),
  );

export const loadLucky77RoundBets = async (round_id: string) =>
  mapRoundBets(
    await prisma.lucky77Bet.findMany({
      where: { round_id },
      select: { user_id: true, option_version_id: true, amount: true },
    }),
  );

export const loadGreedyClassicRoundBets = async (round_id: string) =>
  mapRoundBets(
    await prisma.greedyClassicBet.findMany({
      where: { round_id },
      select: { user_id: true, option_version_id: true, amount: true },
    }),
  );

export const loadTeenPattiRoundBets = async (round_id: string) =>
  mapRoundBets(
    await prisma.teenPattiBet.findMany({
      where: { round_id },
      select: { user_id: true, option_version_id: true, amount: true },
    }),
  );
