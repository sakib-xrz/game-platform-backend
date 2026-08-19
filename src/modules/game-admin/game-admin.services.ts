import httpStatus from 'http-status';
import {
  AuditActorType,
  ConfigVersionStatus,
  GameStatus,
  GreedyRoundStatus,
  GreedyRuntimeStatus,
  Prisma,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { GREEDY_GAME_CODE, GREEDY_SOCKET_ROOM } from '@/modules/greedy/greedy.constant';
import type { CancelRoundBody, CreateGreedyConfigBody } from './game-admin.validation';

const getGameOrThrow = async (tx: Prisma.TransactionClient = prisma) => {
  const game = await tx.game.findUnique({ where: { code: GREEDY_GAME_CODE } });
  if (!game) throw new AppError(httpStatus.NOT_FOUND, 'Greedy game not initialized');
  return game;
};

const createConfig = async (payload: CreateGreedyConfigBody, actor_id?: string) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const latest = await tx.greedyConfigVersion.findFirst({
      where: { game_id: game.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const config = await tx.greedyConfigVersion.create({
      data: {
        game_id: game.id,
        version,
        betting_duration_ms: payload.betting_duration_ms,
        lock_duration_ms: payload.lock_duration_ms,
        drawing_duration_ms: payload.drawing_duration_ms,
        result_duration_ms: payload.result_duration_ms,
        min_bet: BigInt(payload.min_bet),
        max_single_bet: BigInt(payload.max_single_bet),
        max_round_bet: BigInt(payload.max_round_bet),
        notes: payload.notes,
        created_by: actor_id,
        chip_values: {
          create: payload.chip_values.map((chip) => ({
            amount: BigInt(chip.amount),
            display_order: chip.display_order,
            is_enabled: chip.is_enabled,
          })),
        },
        options: {
          create: payload.options.map((option) => ({
            code: option.code,
            name: option.name,
            image_url: option.image_url ?? null,
            display_order: option.display_order,
            payout_numerator: BigInt(option.payout_numerator),
            payout_denominator: BigInt(option.payout_denominator),
            probability_weight: BigInt(option.probability_weight),
            is_enabled: option.is_enabled,
          })),
        },
      },
      include: {
        options: { orderBy: { display_order: 'asc' } },
        chip_values: { orderBy: { display_order: 'asc' } },
      },
    });

    await tx.auditLog.create({
      data: {
        actor_type: AuditActorType.admin,
        actor_id,
        action: 'greedy.config.created',
        entity_type: 'greedy_config_version',
        entity_id: config.id,
        new_values: { version },
      },
    });

    return config;
  });

const listConfigs = async () => {
  const game = await getGameOrThrow();
  return prisma.greedyConfigVersion.findMany({
    where: { game_id: game.id },
    include: {
      options: { orderBy: { display_order: 'asc' } },
      chip_values: { orderBy: { display_order: 'asc' } },
    },
    orderBy: { version: 'desc' },
  });
};

const publishConfig = async (config_id: string, actor_id?: string) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const target = await tx.greedyConfigVersion.findFirst({
      where: { id: config_id, game_id: game.id },
      include: { options: true, chip_values: true },
    });
    if (!target) throw new AppError(httpStatus.NOT_FOUND, 'Config version not found');
    if (target.status !== ConfigVersionStatus.draft) {
      throw new AppError(httpStatus.CONFLICT, 'Only draft configs can be published');
    }
    const enabled_options = target.options.filter((item) => item.is_enabled);
    if (enabled_options.length < 2) {
      throw new AppError(httpStatus.BAD_REQUEST, 'At least two enabled options are required');
    }
    if (!target.chip_values.some((item) => item.is_enabled)) {
      throw new AppError(httpStatus.BAD_REQUEST, 'At least one enabled chip value is required');
    }

    const total_weight = enabled_options.reduce(
      (sum, item) => sum + item.probability_weight,
      0n,
    );
    if (
      total_weight <= 0n ||
      enabled_options.some(
        (item) =>
          item.probability_weight * item.payout_numerator >
          total_weight * item.payout_denominator,
      )
    ) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Published game math failed the expected-payout safety check',
      );
    }

    const now = new Date();
    await tx.greedyConfigVersion.updateMany({
      where: { game_id: game.id, status: ConfigVersionStatus.published },
      data: { status: ConfigVersionStatus.retired, retired_at: now },
    });

    const published = await tx.greedyConfigVersion.update({
      where: { id: target.id },
      data: { status: ConfigVersionStatus.published, published_at: now },
      include: {
        options: { orderBy: { display_order: 'asc' } },
        chip_values: { orderBy: { display_order: 'asc' } },
      },
    });

    await tx.greedyRuntimeState.update({
      where: { game_id: game.id },
      data: { active_config_version_id: target.id, revision: { increment: 1 } },
    });

    await tx.auditLog.create({
      data: {
        actor_type: AuditActorType.admin,
        actor_id,
        action: 'greedy.config.published',
        entity_type: 'greedy_config_version',
        entity_id: target.id,
        new_values: { version: target.version },
      },
    });

    return published;
  });

const getRuntime = async () => {
  const game = await getGameOrThrow();
  return prisma.greedyRuntimeState.findUnique({
    where: { game_id: game.id },
    include: {
      current_round: true,
      active_config_version: {
        include: {
          options: { orderBy: { display_order: 'asc' } },
          chip_values: { orderBy: { display_order: 'asc' } },
        },
      },
    },
  });
};

const resume = async (actor_id?: string) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const runtime = await tx.greedyRuntimeState.findUnique({ where: { game_id: game.id } });
    if (!runtime?.active_config_version_id) {
      throw new AppError(httpStatus.CONFLICT, 'Publish a Greedy config before starting the game');
    }
    await tx.game.update({ where: { id: game.id }, data: { status: GameStatus.active } });
    const updated = await tx.greedyRuntimeState.update({
      where: { game_id: game.id },
      data: { status: GreedyRuntimeStatus.running, revision: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: { actor_type: AuditActorType.admin, actor_id, action: 'greedy.game.resumed', entity_type: 'game', entity_id: game.id },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'game', aggregate_id: game.id,
        event_type: 'platform.game.resumed', socket_room: GREEDY_SOCKET_ROOM,
        payload: { game_code: GREEDY_GAME_CODE },
      },
    });
    return updated;
  });

const pause = async (actor_id?: string) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const updated = await tx.greedyRuntimeState.update({
      where: { game_id: game.id },
      data: { status: GreedyRuntimeStatus.paused, revision: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: { actor_type: AuditActorType.admin, actor_id, action: 'greedy.game.paused', entity_type: 'game', entity_id: game.id },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'game', aggregate_id: game.id,
        event_type: 'platform.game.paused', socket_room: GREEDY_SOCKET_ROOM,
        payload: { game_code: GREEDY_GAME_CODE, current_round_will_finish: true },
      },
    });
    return updated;
  });

const cancelCurrentRound = async (payload: CancelRoundBody, actor_id?: string) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const runtime = await tx.greedyRuntimeState.findUnique({ where: { game_id: game.id } });
    if (!runtime?.current_round_id) {
      throw new AppError(httpStatus.CONFLICT, 'There is no active round to cancel');
    }
    const round = await tx.greedyRound.findUnique({ where: { id: runtime.current_round_id } });
    const cancellable_statuses: GreedyRoundStatus[] = [
      GreedyRoundStatus.created,
      GreedyRoundStatus.betting_open,
      GreedyRoundStatus.betting_locked,
    ];
    if (!round || !cancellable_statuses.includes(round.status)) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Round can only be cancelled before the result is revealed',
      );
    }
    // The worker can advance the round between the read above and this write.
    // Keep cancellation atomic so a result that is being prepared or revealed
    // can never be replaced with a cancelled/refunded round.
    const cancellation = await tx.greedyRound.updateMany({
      where: { id: round.id, status: { in: cancellable_statuses } },
      data: {
        status: GreedyRoundStatus.cancelled,
        cancelled_at: new Date(),
        cancellation_reason: payload.reason,
      },
    });
    if (cancellation.count !== 1) {
      throw new AppError(httpStatus.CONFLICT, 'Round can only be cancelled before the result is prepared');
    }
    const cancelled = await tx.greedyRound.findUniqueOrThrow({ where: { id: round.id } });
    await tx.auditLog.create({
      data: {
        actor_type: AuditActorType.admin, actor_id,
        action: 'greedy.round.cancelled', entity_type: 'greedy_round', entity_id: round.id,
        new_values: { reason: payload.reason },
      },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_round', aggregate_id: round.id,
        event_type: 'greedy.round.cancelled', socket_room: GREEDY_SOCKET_ROOM,
        payload: { round_id: round.id, reason: payload.reason },
      },
    });
    return cancelled;
  });

export default { createConfig, listConfigs, publishConfig, getRuntime, resume, pause, cancelCurrentRound };
