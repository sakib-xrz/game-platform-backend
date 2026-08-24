import prisma from '@/lib/prisma';

export type GameBotPolicyConfig = {
  enabled: boolean;
  target_human_win_rate: number;
  min_bots_per_round: number;
  max_bots_per_round: number;
  min_human_bets_before_bias: number;
};

const DEFAULT_POLICY: GameBotPolicyConfig = {
  enabled: true,
  target_human_win_rate: 0.15,
  min_bots_per_round: 2,
  max_bots_per_round: 8,
  min_human_bets_before_bias: 1,
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
  };
};
