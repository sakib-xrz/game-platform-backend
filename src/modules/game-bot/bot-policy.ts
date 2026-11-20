import prisma from '@/lib/prisma';

export type GameBotPolicyConfig = {
  enabled: boolean;
  target_human_win_rate: number;
  min_bots_per_round: number;
  max_bots_per_round: number;
  min_human_bets_before_bias: number;
  max_human_payout_per_round: bigint;
  win_streak_trigger: number;
  cooling_rounds_after_streak: number;
  cooling_rounds_after_big_win: number;
  cooling_rounds_after_jackpot: number;
  jackpot_cooldown_rounds: number;
  jackpot_multiplier_threshold: number;
  high_jackpot_allow_rate: number;
  mid_jackpot_allow_rate: number;
};

const DEFAULT_POLICY: GameBotPolicyConfig = {
  enabled: true,
  target_human_win_rate: 0.40,
  min_bots_per_round: 6,
  max_bots_per_round: 10,
  min_human_bets_before_bias: 1,
  max_human_payout_per_round: 300_000n,
  win_streak_trigger: 5,
  cooling_rounds_after_streak: 2,
  cooling_rounds_after_big_win: 3,
  cooling_rounds_after_jackpot: 20,
  jackpot_cooldown_rounds: 100,
  jackpot_multiplier_threshold: 25,
  high_jackpot_allow_rate: 0.00303,
  mid_jackpot_allow_rate: 0.004,
};

export const getGameBotPolicy = async (): Promise<GameBotPolicyConfig> => {
  const policy = await prisma.gameBotPolicy.findUnique({ where: { code: 'default' } });
  if (!policy) return DEFAULT_POLICY;
  return {
    enabled: policy.enabled,
    target_human_win_rate: policy.target_human_win_rate,
    min_bots_per_round: policy.min_bots_per_round,
    max_bots_per_round: policy.max_bots_per_round,
    min_human_bets_before_bias: policy.min_human_bets_before_bias,
    max_human_payout_per_round: policy.max_human_payout_per_round,
    win_streak_trigger: policy.win_streak_trigger,
    cooling_rounds_after_streak: policy.cooling_rounds_after_streak,
    cooling_rounds_after_big_win: policy.cooling_rounds_after_big_win,
    cooling_rounds_after_jackpot: policy.cooling_rounds_after_jackpot,
    jackpot_cooldown_rounds: policy.jackpot_cooldown_rounds,
    jackpot_multiplier_threshold: policy.jackpot_multiplier_threshold,
    high_jackpot_allow_rate: policy.high_jackpot_allow_rate,
    mid_jackpot_allow_rate: policy.mid_jackpot_allow_rate,
  };
};
