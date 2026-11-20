import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import type { GameBotPolicyConfig } from '@/modules/game-bot/bot-policy';
import { isBotUserIdSync } from '@/modules/game-bot/bot-identity';

export type PlayerRiskSnapshot = {
  cooling_user_ids: Set<string>;
  jackpot_blocked_user_ids: Set<string>;
};

type TxClient = Prisma.TransactionClient;

const asSet = (ids: string[]): Set<string> => new Set(ids);

/** Load cooling / jackpot locks for humans who bet this round. */
export const loadPlayerRiskSnapshot = async (
  user_ids: string[],
): Promise<PlayerRiskSnapshot> => {
  const humans = [...new Set(user_ids.filter((id) => !isBotUserIdSync(id)))];
  if (!humans.length) {
    return { cooling_user_ids: new Set(), jackpot_blocked_user_ids: new Set() };
  }

  const rows = await prisma.gamePlayerRiskState.findMany({
    where: { user_id: { in: humans } },
    select: {
      user_id: true,
      cooling_remaining: true,
      jackpot_cooldown_remaining: true,
    },
  });

  const cooling: string[] = [];
  const jackpot_blocked: string[] = [];
  for (const row of rows) {
    if (row.cooling_remaining > 0) cooling.push(row.user_id);
    if (row.jackpot_cooldown_remaining > 0) jackpot_blocked.push(row.user_id);
  }
  return {
    cooling_user_ids: asSet(cooling),
    jackpot_blocked_user_ids: asSet(jackpot_blocked),
  };
};

export type ApplyPlayerRiskInput = {
  user_id: string;
  won: boolean;
  payout: bigint;
  multiplier: number;
  policy: GameBotPolicyConfig;
};

/**
 * After a human participates in a settled round:
 * - losses clear streak and tick down cooling / jackpot locks
 * - wins raise streak and may enter cooling / jackpot budget lock
 */
export const applyPlayerRiskAfterRound = async (
  input: ApplyPlayerRiskInput,
  tx: TxClient | typeof prisma = prisma,
): Promise<void> => {
  if (isBotUserIdSync(input.user_id)) return;

  const existing = await tx.gamePlayerRiskState.findUnique({
    where: { user_id: input.user_id },
  });

  let cooling_remaining = existing?.cooling_remaining ?? 0;
  let win_streak = existing?.win_streak ?? 0;
  let jackpot_cooldown_remaining = existing?.jackpot_cooldown_remaining ?? 0;

  if (jackpot_cooldown_remaining > 0) {
    jackpot_cooldown_remaining -= 1;
  }

  if (input.won) {
    win_streak += 1;
    const is_jackpot =
      input.multiplier >= input.policy.jackpot_multiplier_threshold;
    const is_big_win =
      input.multiplier >= 15 || input.payout >= input.policy.max_human_payout_per_round / 2n;

    if (is_jackpot) {
      cooling_remaining = Math.max(
        cooling_remaining,
        input.policy.cooling_rounds_after_jackpot,
      );
      jackpot_cooldown_remaining = Math.max(
        jackpot_cooldown_remaining,
        input.policy.jackpot_cooldown_rounds,
      );
    } else if (is_big_win) {
      cooling_remaining = Math.max(
        cooling_remaining,
        input.policy.cooling_rounds_after_big_win,
      );
    } else if (win_streak >= input.policy.win_streak_trigger) {
      cooling_remaining = Math.max(
        cooling_remaining,
        input.policy.cooling_rounds_after_streak,
      );
    }
  } else {
    win_streak = 0;
    if (cooling_remaining > 0) cooling_remaining -= 1;
  }

  await tx.gamePlayerRiskState.upsert({
    where: { user_id: input.user_id },
    create: {
      user_id: input.user_id,
      cooling_remaining,
      win_streak,
      jackpot_cooldown_remaining,
    },
    update: {
      cooling_remaining,
      win_streak,
      jackpot_cooldown_remaining,
    },
  });
};

export const optionMultiplier = (
  payout_numerator: bigint,
  payout_denominator: bigint,
): number => {
  if (payout_denominator <= 0n) return 0;
  return Number(payout_numerator) / Number(payout_denominator);
};
