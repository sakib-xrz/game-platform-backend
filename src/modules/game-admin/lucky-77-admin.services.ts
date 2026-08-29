import httpStatus from 'http-status';
import {
  AdminRole,
  AdminAssetStatus,
  AdminApprovalStatus,
  ConfigVersionStatus,
  GameStatus,
  Lucky77RoundStatus,
  Lucky77RuntimeStatus,
  Prisma,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { LUCKY_77_GAME_CODE, LUCKY_77_SOCKET_ROOM } from '@/modules/lucky-77/lucky-77.constant';
import type { CancelRoundBody, CreateLucky77ConfigBody } from './game-admin.validation';
import { createPendingApproval, markApprovalApplied, verifyApprovalPayloadHash } from '@/modules/admin/admin-approval.services';
import { canManageGameAvailability } from '@/modules/admin/admin.permissions';
import type { AdminAuditContext } from '@/modules/admin/admin.services';
import { writeAdminAudit } from '@/modules/admin/admin.services';

const getGameOrThrow = async (tx: Prisma.TransactionClient = prisma) => {
  const game = await tx.game.findUnique({ where: { code: LUCKY_77_GAME_CODE } });
  if (!game) throw new AppError(httpStatus.NOT_FOUND, 'Lucky 77 game not initialized');
  return game;
};

export const resolveLucky77OptionAssets = async (tx: Prisma.TransactionClient, options: CreateLucky77ConfigBody['options']): Promise<CreateLucky77ConfigBody['options']> => {
  const asset_ids = [...new Set(options.flatMap((option) => option.asset_id ? [option.asset_id] : []))];
  const assets = asset_ids.length ? await tx.adminAsset.findMany({ where: { id: { in: asset_ids }, status: AdminAssetStatus.ready }, select: { id: true, cdn_url: true } }) : [];
  if (assets.length !== asset_ids.length) throw new AppError(httpStatus.BAD_REQUEST, 'Every referenced option asset must be uploaded and ready');
  const by_id = new Map(assets.map((asset) => [asset.id, asset]));
  return options.map((option) => {
    if (option.image_url && !option.asset_id) throw new AppError(httpStatus.BAD_REQUEST, 'Option artwork must come from a managed asset');
    if (option.asset_id && !by_id.get(option.asset_id)?.cdn_url) throw new AppError(httpStatus.BAD_REQUEST, 'Referenced option asset has no published CDN URL');
    return { ...option, image_url: option.asset_id ? by_id.get(option.asset_id)!.cdn_url : null };
  });
};

const createConfig = async (payload: CreateLucky77ConfigBody, context: AdminAuditContext = {}) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const options = await resolveLucky77OptionAssets(tx, payload.options);
    const latest = await tx.lucky77ConfigVersion.findFirst({
      where: { game_id: game.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const config = await tx.lucky77ConfigVersion.create({
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
        created_by: context.admin_user_id,
        chip_values: {
          create: payload.chip_values.map((chip) => ({
            amount: BigInt(chip.amount),
            display_order: chip.display_order,
            is_enabled: chip.is_enabled,
          })),
        },
        options: {
          create: options.map((option) => ({
            code: option.code,
            name: option.name,
            image_url: option.image_url ?? null,
            asset_id: option.asset_id ?? null,
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

    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'lucky_77.config.created', entity_type: 'lucky_77_config_version', entity_id: config.id, new_values: { version } });

    return config;
  });

const listConfigs = async () => {
  const game = await getGameOrThrow();
  return prisma.lucky77ConfigVersion.findMany({
    where: { game_id: game.id },
    include: {
      options: { orderBy: { display_order: 'asc' } },
      chip_values: { orderBy: { display_order: 'asc' } },
    },
    orderBy: { version: 'desc' },
  });
};

const validateConfig = async (payload: CreateLucky77ConfigBody) => {
  const failures: Array<{ field: string; message: string }> = [];
  const enabled = payload.options.filter((option) => option.is_enabled);
  if (enabled.length !== 3) {
    failures.push({ field: 'options', message: 'Lucky 77 requires exactly three enabled options' });
  }
  const total_weight = enabled.reduce((sum, option) => sum + BigInt(option.probability_weight), 0n);
  const options = enabled.map((option) => {
    const weight = BigInt(option.probability_weight);
    const numerator = BigInt(option.payout_numerator);
    const denominator = BigInt(option.payout_denominator);
    const probability_percent = total_weight ? Number((weight * 1_000_000n) / total_weight) / 10_000 : 0;
    const payout_contribution_percent = total_weight ? Number((weight * numerator * 1_000_000n) / (total_weight * denominator)) / 10_000 : 0;
    return { code: option.code, probability_percent, payout_contribution_percent };
  });
  const theoretical_return_percent = options.length
    ? Math.max(...options.map((option) => option.payout_contribution_percent))
    : 0;
  const asset_ids = [...new Set(payload.options.flatMap((option) => option.asset_id ? [option.asset_id] : []))];
  const assets = asset_ids.length ? await prisma.adminAsset.findMany({ where: { id: { in: asset_ids }, status: AdminAssetStatus.ready }, select: { id: true, cdn_url: true } }) : [];
  const ready_assets = new Map(assets.map((asset) => [asset.id, asset]));
  payload.options.forEach((option) => {
    if (option.image_url && !option.asset_id) failures.push({ field: `options.${option.code}.image_url`, message: 'Option artwork must come from a managed asset' });
    if (option.asset_id && (!ready_assets.has(option.asset_id) || !ready_assets.get(option.asset_id)?.cdn_url)) failures.push({ field: `options.${option.code}.asset_id`, message: 'Referenced managed asset is not ready' });
  });
  if (theoretical_return_percent > 100) failures.push({ field: 'options', message: 'An enabled option exceeds 100% theoretical return' });
  return {
    valid: theoretical_return_percent <= 100 && enabled.length === 3 && failures.length === 0,
    failures,
    total_weight: total_weight.toString(),
    theoretical_return_percent,
    options,
  };
};

const getRuntime = async () => {
  const game = await getGameOrThrow();
  return prisma.lucky77RuntimeState.findUnique({
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

const resume = async (context: AdminAuditContext = {}) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    if (game.status === GameStatus.disabled && !canManageGameAvailability(context.actor_role)) {
      throw new AppError(httpStatus.FORBIDDEN, 'Only a game admin can resume a disabled game');
    }
    const runtime = await tx.lucky77RuntimeState.findUnique({ where: { game_id: game.id } });
    if (!runtime?.active_config_version_id) {
      throw new AppError(httpStatus.CONFLICT, 'Publish a Lucky 77 config before starting the game');
    }
    await tx.game.update({ where: { id: game.id }, data: { status: GameStatus.active } });
    const updated = await tx.lucky77RuntimeState.update({
      where: { game_id: game.id },
      data: { status: Lucky77RuntimeStatus.running, revision: { increment: 1 } },
    });
    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'lucky_77.game.resumed', entity_type: 'game', entity_id: game.id });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'game', aggregate_id: game.id,
        event_type: 'platform.game.resumed', socket_room: LUCKY_77_SOCKET_ROOM,
        payload: { game_code: LUCKY_77_GAME_CODE },
      },
    });
    return updated;
  });

const pause = async (context: AdminAuditContext = {}) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const updated = await tx.lucky77RuntimeState.update({
      where: { game_id: game.id },
      data: { status: Lucky77RuntimeStatus.paused, revision: { increment: 1 } },
    });
    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'lucky_77.game.paused', entity_type: 'game', entity_id: game.id });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'game', aggregate_id: game.id,
        event_type: 'platform.game.paused', socket_room: LUCKY_77_SOCKET_ROOM,
        payload: { game_code: LUCKY_77_GAME_CODE, current_round_will_finish: true },
      },
    });
    return updated;
  });

const cancelCurrentRound = async (payload: CancelRoundBody, context: AdminAuditContext = {}) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const runtime = await tx.lucky77RuntimeState.findUnique({ where: { game_id: game.id } });
    if (!runtime?.current_round_id) {
      throw new AppError(httpStatus.CONFLICT, 'There is no active round to cancel');
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM lucky_77_rounds WHERE id = ${runtime.current_round_id} FOR UPDATE`);
    const round = await tx.lucky77Round.findUnique({ where: { id: runtime.current_round_id }, include: { config_version: { select: { lock_duration_ms: true, drawing_duration_ms: true, result_duration_ms: true } } } });
    const cancellable_statuses: Lucky77RoundStatus[] = [
      Lucky77RoundStatus.created,
      Lucky77RoundStatus.betting_open,
      Lucky77RoundStatus.betting_locked,
    ];
    if (!round || !cancellable_statuses.includes(round.status)) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Round can only be cancelled before the result is revealed',
      );
    }
    const exposure = await tx.lucky77Bet.aggregate({ where: { round_id: round.id }, _sum: { amount: true }, _count: { _all: true } });
    const policy = await tx.adminPolicy.findUnique({ where: { code: 'default' } });
    const threshold = policy?.wallet_adjustment_threshold ?? 10000n;
    const exposure_amount = exposure._sum.amount ?? 0n;
    if (!payload.approval_id && exposure_amount >= threshold) {
      if (!context.admin_user_id || !context.idempotency_key) throw new AppError(httpStatus.UNAUTHORIZED, 'Authenticated admin and Idempotency-Key are required');
      const policy_expiry = new Date(Date.now() + (policy?.approval_expiry_minutes ?? 1440) * 60_000);
      const lifecycle_base = round.betting_ends_at ?? round.locked_at ?? new Date();
      const lifecycle_expiry = new Date(lifecycle_base.getTime() + round.config_version.lock_duration_ms + round.config_version.drawing_duration_ms + round.config_version.result_duration_ms);
      const expires_at = new Date(Math.min(policy_expiry.getTime(), lifecycle_expiry.getTime()));
      const approval = await createPendingApproval({ admin_user_id: context.admin_user_id, action_type: 'lucky_77.round.cancel', target_type: 'lucky_77_round', target_id: round.id, payload: { round_id: round.id, reason: payload.reason, exposure: exposure_amount.toString(), current_round_id: runtime.current_round_id }, idempotency_key: context.idempotency_key, expires_at }, tx);
      await writeAdminAudit(tx, { ...context, approval_request_id: approval.id, outcome: 'success' }, { action: 'lucky_77.round.cancellation_submitted_for_approval', entity_type: 'lucky_77_round', entity_id: round.id, new_values: { reason: payload.reason, exposure: exposure_amount.toString(), bet_count: exposure._count._all } });
      return { status: 'pending_approval' as const, approval_id: approval.id, round_id: round.id, exposure: exposure_amount.toString(), expires_at: approval.expires_at };
    }
    if (payload.approval_id) {
      const approval = await tx.adminApprovalRequest.findUnique({ where: { id: payload.approval_id } });
      if (!approval || approval.action_type !== 'lucky_77.round.cancel' || approval.status !== AdminApprovalStatus.approved || approval.expires_at <= new Date()) throw new AppError(httpStatus.CONFLICT, 'Round cancellation approval is not ready');
      verifyApprovalPayloadHash(approval.payload, approval.payload_hash);
      const approved = approval.payload as { round_id?: string; reason?: string; exposure?: string; current_round_id?: string | null };
      if (approved.round_id !== round.id || approved.reason !== payload.reason || approved.exposure !== exposure_amount.toString() || approved.current_round_id !== runtime.current_round_id) throw new AppError(httpStatus.CONFLICT, 'Round cancellation no longer matches the approved snapshot');
    }
    // The worker can advance the round between the read above and this write.
    // Keep cancellation atomic so a result that is being prepared or revealed
    // can never be replaced with a cancelled/refunded round.
    const cancellation = await tx.lucky77Round.updateMany({
      where: { id: round.id, status: { in: cancellable_statuses } },
      data: {
        status: Lucky77RoundStatus.cancelled,
        cancelled_at: new Date(),
        cancellation_reason: payload.reason,
      },
    });
    if (cancellation.count !== 1) {
      throw new AppError(httpStatus.CONFLICT, 'Round can only be cancelled before the result is prepared');
    }
    const cancelled = await tx.lucky77Round.findUniqueOrThrow({ where: { id: round.id } });
    await writeAdminAudit(tx, { ...context, approval_request_id: payload.approval_id, outcome: 'success' }, { action: 'lucky_77.round.cancelled', entity_type: 'lucky_77_round', entity_id: round.id, new_values: { reason: payload.reason } });
    if (payload.approval_id) await markApprovalApplied(tx, payload.approval_id, context);
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'lucky_77_round', aggregate_id: round.id,
        event_type: 'lucky_77.round.cancelled', socket_room: LUCKY_77_SOCKET_ROOM,
        payload: { round_id: round.id, reason: payload.reason },
      },
    });
    return cancelled;
  });

const requestPublishConfig = async (config_id: string, context: AdminAuditContext) =>
  prisma.$transaction(async (tx) => {
    const admin_user_id = context.admin_user_id;
    const idempotency_key = context.idempotency_key;
    if (!admin_user_id || !idempotency_key) throw new AppError(httpStatus.UNAUTHORIZED, 'Authenticated admin and Idempotency-Key are required');
    const game = await getGameOrThrow(tx);
    const target = await tx.lucky77ConfigVersion.findFirst({ where: { id: config_id, game_id: game.id }, include: { options: true, chip_values: true } });
    if (!target) throw new AppError(httpStatus.NOT_FOUND, 'Config version not found');
    if (target.status !== ConfigVersionStatus.draft) throw new AppError(httpStatus.CONFLICT, 'Only draft configs can be submitted for approval');
    const enabled_options = target.options.filter((item) => item.is_enabled);
    if (enabled_options.length !== 3 || !target.chip_values.some((item) => item.is_enabled)) throw new AppError(httpStatus.BAD_REQUEST, 'Config must contain exactly three enabled options and chips');
    const total_weight = enabled_options.reduce((sum, item) => sum + item.probability_weight, 0n);
    if (total_weight <= 0n || enabled_options.some((item) => item.probability_weight * item.payout_numerator > total_weight * item.payout_denominator)) throw new AppError(httpStatus.BAD_REQUEST, 'Published game math failed the expected-payout safety check');
    const approval = await createPendingApproval({ admin_user_id, action_type: 'lucky_77.config.publish', target_type: 'lucky_77_config_version', target_id: target.id, payload: { config_id: target.id, version: target.version }, idempotency_key }, tx);
    await tx.lucky77ConfigVersion.update({ where: { id: target.id }, data: { status: ConfigVersionStatus.review_pending } });
    await writeAdminAudit(tx, { ...context, approval_request_id: approval.id, outcome: 'success' }, { action: 'lucky_77.config.submitted_for_approval', entity_type: 'lucky_77_config_version', entity_id: target.id, new_values: { version: target.version, approval_id: approval.id } });
    return { status: 'pending_approval' as const, approval_id: approval.id, config_id: target.id, version: target.version, expires_at: approval.expires_at };
  });

const publishApprovedConfig = async (approval_id: string, context: AdminAuditContext) =>
  prisma.$transaction(async (tx) => {
    const admin_user_id = context.admin_user_id;
    if (!admin_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin identity is required');
    const approval = await tx.adminApprovalRequest.findUnique({ where: { id: approval_id }, include: { decisions: true } });
    if (!approval || approval.action_type !== 'lucky_77.config.publish') throw new AppError(httpStatus.NOT_FOUND, 'Config publish approval not found');
    if (approval.requested_by_admin_id !== admin_user_id) throw new AppError(httpStatus.FORBIDDEN, 'Only the requesting admin can apply this approval');
    if (approval.status !== AdminApprovalStatus.approved || approval.expires_at <= new Date()) throw new AppError(httpStatus.CONFLICT, 'Config publish approval is not ready');
    verifyApprovalPayloadHash(approval.payload, approval.payload_hash);
    const payload = approval.payload as { config_id?: string };
    const game = await getGameOrThrow(tx);
    const target = await tx.lucky77ConfigVersion.findFirst({ where: { id: payload.config_id, game_id: game.id, status: ConfigVersionStatus.review_pending }, include: { options: true, chip_values: true } });
    if (!target) throw new AppError(httpStatus.CONFLICT, 'Config is no longer awaiting approval');
    const now = new Date();
    await tx.lucky77ConfigVersion.updateMany({ where: { game_id: game.id, status: ConfigVersionStatus.published }, data: { status: ConfigVersionStatus.retired, retired_at: now } });
    const published = await tx.lucky77ConfigVersion.update({ where: { id: target.id }, data: { status: ConfigVersionStatus.published, published_at: now }, include: { options: { orderBy: { display_order: 'asc' } }, chip_values: { orderBy: { display_order: 'asc' } } } });
    await tx.lucky77RuntimeState.update({ where: { game_id: game.id }, data: { active_config_version_id: target.id, revision: { increment: 1 } } });
    await markApprovalApplied(tx, approval.id, context);
    await writeAdminAudit(tx, { ...context, approval_request_id: approval.id, outcome: 'success' }, { action: 'lucky_77.config.published', entity_type: 'lucky_77_config_version', entity_id: target.id, new_values: { version: target.version } });
    return published;
  });

export default { createConfig, listConfigs, validateConfig, requestPublishConfig, publishApprovedConfig, getRuntime, resume, pause, cancelCurrentRound };
