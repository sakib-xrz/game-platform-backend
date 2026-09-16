import {
  pickBiasedWinner,
  pickNaturalWinner,
  type BiasedBetStake,
  type BiasedOption,
  type PickBiasedWinnerResult,
} from '@/modules/game-bot/biased-outcome';
import type { GameBotPolicyConfig } from '@/modules/game-bot/bot-policy';
import { loadPlayerRiskSnapshot } from '@/modules/game-bot/player-risk';

type SelectInput = {
  options: BiasedOption[];
  bets: BiasedBetStake[];
  policy: GameBotPolicyConfig;
};

export const selectRoundWinner = async (
  input: SelectInput,
): Promise<PickBiasedWinnerResult> => {
  if (!input.policy.enabled) {
    return pickNaturalWinner(input.options);
  }

  const human_ids = input.bets.filter((bet) => !bet.is_bot).map((bet) => bet.user_id);
  const risk = await loadPlayerRiskSnapshot(human_ids);

  return pickBiasedWinner({
    options: input.options,
    bets: input.bets,
    target_human_win_rate: input.policy.target_human_win_rate,
    min_human_bets_before_bias: input.policy.min_human_bets_before_bias,
    max_human_payout_per_round: input.policy.max_human_payout_per_round,
    cooling_user_ids: risk.cooling_user_ids,
    jackpot_blocked_user_ids: risk.jackpot_blocked_user_ids,
    jackpot_multiplier_threshold: input.policy.jackpot_multiplier_threshold,
    high_jackpot_allow_rate: input.policy.high_jackpot_allow_rate,
    mid_jackpot_allow_rate: input.policy.mid_jackpot_allow_rate,
  });
};
