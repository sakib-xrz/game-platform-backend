import prisma from '@/lib/prisma';
import { resolveGameIdentitySync } from '@/modules/game-bot/bot-identity';
import {
  compareGreedyWinnerRankings,
  type GreedyWinnerAggregateInput,
  type GreedyWinnerRanking,
} from '@/modules/greedy/greedy.utils';
import { calculateHumanFixedDoublePayout } from './teen-patti.payout';
import type { TeenPattiTopWinner } from './teen-patti.types';

export type TeenPattiLeaderboardTarget = {
  round_id: string;
  winning_option_id: string;
};

export const rankTeenPattiWinnerAggregates = (
  aggregates: GreedyWinnerAggregateInput[],
  limit = 3,
): TeenPattiTopWinner[] =>
  aggregates
    .map((aggregate): GreedyWinnerRanking => ({
      ...aggregate,
      total_payout: calculateHumanFixedDoublePayout(aggregate.winning_stake),
    }))
    .sort(compareGreedyWinnerRankings)
    .slice(0, Math.max(0, limit))
    .map((winner, index) => {
      const identity = resolveGameIdentitySync(winner.user_id);
      return {
        rank: index + 1,
        user_id: winner.user_id,
        display_name: identity.display_name,
        avatar_url: identity.avatar_url,
        winning_stake: winner.winning_stake.toString(),
        bet_count: winner.bet_count,
        total_payout: winner.total_payout.toString(),
        first_bet_at: winner.first_bet_at.toISOString(),
      };
    });

/**
 * Loads winning-hand stakes per user, including bots, then ranks by fixed
 * double gross payout with the same deterministic tie-breaks as Greedy.
 */
export const getTeenPattiTopWinnersByRound = async (
  targets: TeenPattiLeaderboardTarget[],
): Promise<Map<string, TeenPattiTopWinner[]>> => {
  const unique_targets = [
    ...new Map(
      targets.map((target) => [target.round_id, target]),
    ).values(),
  ];
  const winners_by_round = new Map<string, TeenPattiTopWinner[]>();

  if (!unique_targets.length) return winners_by_round;

  const aggregates = await prisma.teenPattiBet.groupBy({
    by: ['round_id', 'user_id'],
    where: {
      OR: unique_targets.map((target) => ({
        round_id: target.round_id,
        option_version_id: target.winning_option_id,
      })),
    },
    _sum: { amount: true },
    _count: { _all: true },
    _min: { accepted_at: true },
  });

  const aggregates_by_round = new Map<
    string,
    GreedyWinnerAggregateInput[]
  >();

  for (const aggregate of aggregates) {
    if (
      aggregate._sum.amount === null ||
      aggregate._min.accepted_at === null
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
      rankTeenPattiWinnerAggregates(
        aggregates_by_round.get(target.round_id) ?? [],
      ),
    );
  }

  return winners_by_round;
};
