import prisma from '@/lib/prisma';
import { getActiveBotIds } from '@/modules/game-bot/bot-identity';
import type { GreedyTopWinner } from './greedy.types';
import { rankGreedyWinnerAggregates } from './greedy.utils';

export type GreedyLeaderboardTarget = {
  round_id: string;
  winning_option_id: string;
  payout_numerator: bigint;
  payout_denominator: bigint;
};

/**
 * Loads already-grouped winning stakes, then applies the shared pure ranking
 * rules. One query can decorate the current result and a page of history.
 * Bot users are excluded — the podium is humans only.
 */
export const getGreedyTopWinnersByRound = async (
  targets: GreedyLeaderboardTarget[],
): Promise<Map<string, GreedyTopWinner[]>> => {
  const unique_targets = [
    ...new Map(
      targets.map((target) => [target.round_id, target]),
    ).values(),
  ];
  const winners_by_round = new Map<string, GreedyTopWinner[]>();

  if (!unique_targets.length) return winners_by_round;

  const bot_ids = new Set(await getActiveBotIds());

  const aggregates = await prisma.greedyBet.groupBy({
    by: ['round_id', 'user_id'],
    where: {
      OR: unique_targets.map((target) => ({
        round_id: target.round_id,
        option_version_id: target.winning_option_id,
      })),
      ...(bot_ids.size
        ? { user_id: { notIn: [...bot_ids] } }
        : {}),
    },
    _sum: { amount: true },
    _count: { _all: true },
    _min: { accepted_at: true },
  });

  const aggregates_by_round = new Map<
    string,
    Array<{
      user_id: string;
      winning_stake: bigint;
      bet_count: number;
      first_bet_at: Date;
    }>
  >();

  for (const aggregate of aggregates) {
    if (
      aggregate._sum.amount === null ||
      aggregate._min.accepted_at === null ||
      bot_ids.has(aggregate.user_id)
    ) {
      continue;
    }
    const round_aggregates = aggregates_by_round.get(aggregate.round_id) ?? [];
    round_aggregates.push({
      user_id: aggregate.user_id,
      winning_stake: aggregate._sum.amount,
      bet_count: aggregate._count._all,
      first_bet_at: aggregate._min.accepted_at,
    });
    aggregates_by_round.set(aggregate.round_id, round_aggregates);
  }

  for (const target of unique_targets) {
    winners_by_round.set(
      target.round_id,
      rankGreedyWinnerAggregates(
        aggregates_by_round.get(target.round_id) ?? [],
        target.payout_numerator,
        target.payout_denominator,
      ),
    );
  }

  return winners_by_round;
};
