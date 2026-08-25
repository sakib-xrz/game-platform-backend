import prisma from '@/lib/prisma';
import {
  GameStatus,
  GreedyClassicRoundStatus,
  GreedyClassicRuntimeStatus,
  GreedyRoundStatus,
  GreedyRuntimeStatus,
  Lucky77RoundStatus,
  Lucky77RuntimeStatus,
  TeenPattiRoundStatus,
  TeenPattiRuntimeStatus,
} from '@/generated/prisma/client';
import GreedyService from '@/modules/greedy/greedy.services';
import GreedyClassicService from '@/modules/greedy-classic/greedy-classic.services';
import Lucky77Service from '@/modules/lucky-77/lucky-77.services';
import TeenPattiService from '@/modules/teen-patti/teen-patti.services';
import { GREEDY_GAME_CODE } from '@/modules/greedy/greedy.constant';
import { GREEDY_CLASSIC_GAME_CODE } from '@/modules/greedy-classic/greedy-classic.constant';
import { LUCKY_77_GAME_CODE } from '@/modules/lucky-77/lucky-77.constant';
import { TEEN_PATTI_GAME_CODE } from '@/modules/teen-patti/teen-patti.constant';
import {
  getActiveBots,
  isBotUserId,
  refreshBotIdentityCache,
} from '@/modules/game-bot/bot-identity';
import { getGameBotPolicy } from '@/modules/game-bot/bot-policy';
import { logger } from '@/utils/logger';

type OpenRoundContext = {
  game_code: string;
  round_id: string;
  betting_started_at: Date;
  betting_ends_at: Date;
  chip_amounts: bigint[];
  option_ids: string[];
  winning_option_id?: string | null;
};

const pickChipAmount = (amounts: bigint[], persona_seed: number): bigint => {
  if (!amounts.length) return 100n;
  const index = Math.abs(persona_seed) % amounts.length;
  return amounts[index] ?? amounts[0]!;
};

const pickOptionId = (option_ids: string[], persona_seed: number): string => {
  if (!option_ids.length) {
    throw new Error('No betting options available for bot placement');
  }
  const index = Math.abs(persona_seed) % option_ids.length;
  return option_ids[index] ?? option_ids[0]!;
};

const shouldActivateBots = (
  betting_started_at: Date,
  betting_ends_at: Date,
  human_bet_count: number,
): boolean => {
  const duration = betting_ends_at.getTime() - betting_started_at.getTime();
  const elapsed = Date.now() - betting_started_at.getTime();
  return human_bet_count > 0 || elapsed >= duration * 0.2;
};

const countHumanBets = async (round_id: string, game_code: string): Promise<number> => {
  const bets =
    game_code === GREEDY_GAME_CODE
      ? await prisma.greedyBet.findMany({ where: { round_id }, select: { user_id: true } })
      : game_code === GREEDY_CLASSIC_GAME_CODE
        ? await prisma.greedyClassicBet.findMany({ where: { round_id }, select: { user_id: true } })
        : game_code === LUCKY_77_GAME_CODE
          ? await prisma.lucky77Bet.findMany({ where: { round_id }, select: { user_id: true } })
          : await prisma.teenPattiBet.findMany({ where: { round_id }, select: { user_id: true } });

  let human_count = 0;
  for (const bet of bets) {
    if (!(await isBotUserId(bet.user_id))) human_count += 1;
  }
  return human_count;
};

const countBotBets = async (round_id: string, game_code: string): Promise<number> => {
  const bets =
    game_code === GREEDY_GAME_CODE
      ? await prisma.greedyBet.findMany({ where: { round_id }, select: { user_id: true } })
      : game_code === GREEDY_CLASSIC_GAME_CODE
        ? await prisma.greedyClassicBet.findMany({ where: { round_id }, select: { user_id: true } })
        : game_code === LUCKY_77_GAME_CODE
          ? await prisma.lucky77Bet.findMany({ where: { round_id }, select: { user_id: true } })
          : await prisma.teenPattiBet.findMany({ where: { round_id }, select: { user_id: true } });

  let bot_count = 0;
  for (const bet of bets) {
    if (await isBotUserId(bet.user_id)) bot_count += 1;
  }
  return bot_count;
};

const placeGameBotBet = async (
  context: OpenRoundContext,
  bot: { id: string; persona_seed: number },
  sequence: number,
) => {
  const amount = pickChipAmount(context.chip_amounts, bot.persona_seed + sequence);
  const option_id =
    context.game_code === TEEN_PATTI_GAME_CODE && context.winning_option_id
      ? context.winning_option_id
      : pickOptionId(context.option_ids, bot.persona_seed + sequence);
  const client_request_id = `bot:${context.round_id}:${bot.id}:${sequence}`;
  const payload = {
    round_id: context.round_id,
    option_id,
    amount: amount.toString(),
    client_request_id,
  };

  if (context.game_code === GREEDY_GAME_CODE) {
    await GreedyService.placeBet(bot.id, payload);
    return;
  }
  if (context.game_code === GREEDY_CLASSIC_GAME_CODE) {
    await GreedyClassicService.placeBet(bot.id, payload);
    return;
  }
  if (context.game_code === LUCKY_77_GAME_CODE) {
    await Lucky77Service.placeBet(bot.id, payload);
    return;
  }
  await TeenPattiService.placeBet(bot.id, payload);
};

const loadGreedyContext = async (): Promise<OpenRoundContext | null> => {
  const runtime = await prisma.greedyRuntimeState.findFirst({
    where: { game: { code: GREEDY_GAME_CODE, status: GameStatus.active }, status: GreedyRuntimeStatus.running },
    include: {
      active_config_version: {
        include: {
          chip_values: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
          options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
        },
      },
    },
  });
  if (!runtime?.current_round_id || !runtime.active_config_version) return null;
  const round = await prisma.greedyRound.findUnique({
    where: { id: runtime.current_round_id },
    select: { id: true, status: true, betting_started_at: true, betting_ends_at: true },
  });
  if (!round || round.status !== GreedyRoundStatus.betting_open || !round.betting_started_at || !round.betting_ends_at) {
    return null;
  }
  return {
    game_code: GREEDY_GAME_CODE,
    round_id: round.id,
    betting_started_at: round.betting_started_at,
    betting_ends_at: round.betting_ends_at,
    chip_amounts: runtime.active_config_version.chip_values.map((chip) => chip.amount),
    option_ids: runtime.active_config_version.options.map((option) => option.id),
  };
};

const loadGreedyClassicContext = async (): Promise<OpenRoundContext | null> => {
  const runtime = await prisma.greedyClassicRuntimeState.findFirst({
    where: {
      game: { code: GREEDY_CLASSIC_GAME_CODE, status: GameStatus.active },
      status: GreedyClassicRuntimeStatus.running,
    },
    include: {
      active_config_version: {
        include: {
          chip_values: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
          options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
        },
      },
    },
  });
  if (!runtime?.current_round_id || !runtime.active_config_version) return null;
  const round = await prisma.greedyClassicRound.findUnique({
    where: { id: runtime.current_round_id },
    select: { id: true, status: true, betting_started_at: true, betting_ends_at: true },
  });
  if (!round || round.status !== GreedyClassicRoundStatus.betting_open || !round.betting_started_at || !round.betting_ends_at) {
    return null;
  }
  return {
    game_code: GREEDY_CLASSIC_GAME_CODE,
    round_id: round.id,
    betting_started_at: round.betting_started_at,
    betting_ends_at: round.betting_ends_at,
    chip_amounts: runtime.active_config_version.chip_values.map((chip) => chip.amount),
    option_ids: runtime.active_config_version.options.map((option) => option.id),
  };
};

const loadLucky77Context = async (): Promise<OpenRoundContext | null> => {
  const runtime = await prisma.lucky77RuntimeState.findFirst({
    where: { game: { code: LUCKY_77_GAME_CODE, status: GameStatus.active }, status: Lucky77RuntimeStatus.running },
    include: {
      active_config_version: {
        include: {
          chip_values: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
          options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
        },
      },
    },
  });
  if (!runtime?.current_round_id || !runtime.active_config_version) return null;
  const round = await prisma.lucky77Round.findUnique({
    where: { id: runtime.current_round_id },
    select: { id: true, status: true, betting_started_at: true, betting_ends_at: true },
  });
  if (!round || round.status !== Lucky77RoundStatus.betting_open || !round.betting_started_at || !round.betting_ends_at) {
    return null;
  }
  return {
    game_code: LUCKY_77_GAME_CODE,
    round_id: round.id,
    betting_started_at: round.betting_started_at,
    betting_ends_at: round.betting_ends_at,
    chip_amounts: runtime.active_config_version.chip_values.map((chip) => chip.amount),
    option_ids: runtime.active_config_version.options.map((option) => option.id),
  };
};

const loadTeenPattiContext = async (): Promise<OpenRoundContext | null> => {
  const runtime = await prisma.teenPattiRuntimeState.findFirst({
    where: { game: { code: TEEN_PATTI_GAME_CODE, status: GameStatus.active }, status: TeenPattiRuntimeStatus.running },
    include: {
      active_config_version: {
        include: {
          chip_values: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
          options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } },
        },
      },
    },
  });
  if (!runtime?.current_round_id || !runtime.active_config_version) return null;
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: runtime.current_round_id },
    include: { result: { select: { winning_option_version_id: true } } },
  });
  if (!round || round.status !== TeenPattiRoundStatus.betting_open || !round.betting_started_at || !round.betting_ends_at) {
    return null;
  }
  return {
    game_code: TEEN_PATTI_GAME_CODE,
    round_id: round.id,
    betting_started_at: round.betting_started_at,
    betting_ends_at: round.betting_ends_at,
    chip_amounts: runtime.active_config_version.chip_values.map((chip) => chip.amount),
    option_ids: runtime.active_config_version.options.map((option) => option.id),
    winning_option_id: round.result?.winning_option_version_id ?? null,
  };
};

const orchestrateRound = async (context: OpenRoundContext, policy: Awaited<ReturnType<typeof getGameBotPolicy>>) => {
  const human_bets = await countHumanBets(context.round_id, context.game_code);
  if (!shouldActivateBots(context.betting_started_at, context.betting_ends_at, human_bets)) return;

  const existing_bot_bets = await countBotBets(context.round_id, context.game_code);
  const target_bots = Math.min(
    policy.max_bots_per_round,
    Math.max(policy.min_bots_per_round, human_bets > 0 ? policy.max_bots_per_round : policy.min_bots_per_round),
  );
  const bets_to_place = Math.max(0, target_bots - existing_bot_bets);
  if (!bets_to_place) return;

  const bots = await getActiveBots();
  if (!bots.length) return;

  const selected = bots
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, bets_to_place);

  for (const [index, bot] of selected.entries()) {
    try {
      await placeGameBotBet(context, { id: bot.id, persona_seed: bot.persona_seed }, existing_bot_bets + index + 1);
    } catch (error) {
      logger.warn('game_bot_bet_failed', {
        game_code: context.game_code,
        round_id: context.round_id,
        bot_id: bot.id,
        error,
      });
    }
  }
};

export const runBotOrchestratorTick = async (): Promise<void> => {
  const policy = await getGameBotPolicy();
  if (!policy.enabled) return;

  await refreshBotIdentityCache();

  const contexts = await Promise.all([
    loadGreedyContext(),
    loadGreedyClassicContext(),
    loadLucky77Context(),
    loadTeenPattiContext(),
  ]);

  for (const context of contexts) {
    if (!context) continue;
    await orchestrateRound(context, policy);
  }
};
