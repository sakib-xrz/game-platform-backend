import httpStatus from 'http-status';
import { Prisma, PlatformAppStatus } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import config from '@/config';
import type { AuthenticatedAdmin } from '@/modules/admin/admin.types';
import { writeAdminAudit, type AdminAuditContext } from '@/modules/admin/admin.services';
import type { CreatePlatformAppBody, UpdatePlatformAppBody } from './platform-app.validation';
import { normalizePackageName, normalizeShaKey } from './platform-app.validation';
import {
  generatePlatformSigningSecret,
  maskSigningSecret,
} from '@/utils/platform-signature';
import { SeamlessWalletClient } from '@/modules/platform-integration/seamless-wallet.client';
import { signPlayerToken } from '@/utils/player-token';

const platformAppSelect = {
  id: true,
  app_name: true,
  app_key: true,
  package_name: true,
  sha_key: true,
  signing_secret: true,
  signing_secret_previous: true,
  wallet_mode: true,
  wallet_base_url: true,
  player_token_secret: true,
  allowed_origins: true,
  status: true,
  created_by_admin_id: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.PlatformAppSelect;

const serializePlatformApp = (
  app: Prisma.PlatformAppGetPayload<{ select: typeof platformAppSelect }>,
  options: { reveal_signing_secret?: boolean } = {},
) => ({
  id: app.id,
  app_name: app.app_name,
  app_key: app.app_key,
  package_name: app.package_name,
  sha_key: app.sha_key,
  signing_secret_preview: maskSigningSecret(app.signing_secret),
  has_rotated_signing_secret: Boolean(app.signing_secret_previous),
  wallet_mode: app.wallet_mode || 'local',
  wallet_base_url: app.wallet_base_url,
  player_token_secret: app.player_token_secret,
  allowed_origins: app.allowed_origins,
  status: app.status,
  created_by_admin_id: app.created_by_admin_id,
  created_at: app.created_at.toISOString(),
  updated_at: app.updated_at.toISOString(),
  ...(options.reveal_signing_secret
    ? { signing_secret: app.signing_secret }
    : {}),
});

const findPlatformAppOrThrow = async (app_id: string) => {
  const app = await prisma.platformApp.findUnique({
    where: { id: app_id },
    select: platformAppSelect,
  });
  if (!app) {
    throw new AppError(httpStatus.NOT_FOUND, 'Platform app not found');
  }
  return app;
};

const listPlatformApps = async () => {
  const apps = await prisma.platformApp.findMany({
    select: platformAppSelect,
    orderBy: [{ status: 'asc' }, { app_name: 'asc' }],
  });
  return apps.map((app) => serializePlatformApp(app));
};

const getPlatformApp = async (app_id: string) =>
  serializePlatformApp(await findPlatformAppOrThrow(app_id));

const createPlatformApp = async (
  admin: AuthenticatedAdmin,
  body: CreatePlatformAppBody,
  context: AdminAuditContext,
) => {
  const package_name = normalizePackageName(body.package_name);
  const sha_key = normalizeShaKey(body.sha_key);

  const existing = await prisma.platformApp.findUnique({
    where: { package_name },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(httpStatus.CONFLICT, 'A platform app with this package name already exists');
  }

  const app = await prisma.$transaction(async (tx) => {
    const signing_secret = generatePlatformSigningSecret();
    const created = await tx.platformApp.create({
      data: {
        app_name: body.app_name.trim(),
        app_key: (body as any).app_key ? (body as any).app_key.trim() : null,
        package_name,
        sha_key,
        signing_secret,
        wallet_mode: (body as any).wallet_mode || 'local',
        wallet_base_url: (body as any).wallet_base_url ? (body as any).wallet_base_url.trim() : null,
        player_token_secret: (body as any).player_token_secret ? (body as any).player_token_secret.trim() : null,
        allowed_origins: (body as any).allowed_origins ? (body as any).allowed_origins.trim() : null,
        status: body.status === 'disabled' ? PlatformAppStatus.disabled : PlatformAppStatus.active,
        created_by_admin_id: admin.id,
      },
      select: platformAppSelect,
    });

    await writeAdminAudit(tx, context, {
      action: 'platform_app.create',
      entity_type: 'platform_app',
      entity_id: created.id,
      new_values: {
        app_name: created.app_name,
        package_name: created.package_name,
        sha_key: created.sha_key,
        status: created.status,
        signing_secret_preview: maskSigningSecret(signing_secret),
      },
    });

    return created;
  });

  return serializePlatformApp(app, { reveal_signing_secret: true });
};

const updatePlatformApp = async (
  app_id: string,
  body: UpdatePlatformAppBody,
  context: AdminAuditContext,
) => {
  const existing = await findPlatformAppOrThrow(app_id);

  const package_name = body.package_name
    ? normalizePackageName(body.package_name)
    : undefined;
  const sha_key = body.sha_key ? normalizeShaKey(body.sha_key) : undefined;

  if (package_name && package_name !== existing.package_name) {
    const conflict = await prisma.platformApp.findUnique({
      where: { package_name },
      select: { id: true },
    });
    if (conflict && conflict.id !== app_id) {
      throw new AppError(httpStatus.CONFLICT, 'A platform app with this package name already exists');
    }
  }

  const app = await prisma.$transaction(async (tx) => {
    const updated = await tx.platformApp.update({
      where: { id: app_id },
      data: {
        ...(body.app_name !== undefined ? { app_name: body.app_name.trim() } : {}),
        ...((body as any).app_key !== undefined
          ? { app_key: (body as any).app_key ? (body as any).app_key.trim() : null }
          : {}),
        ...(package_name !== undefined ? { package_name } : {}),
        ...(sha_key !== undefined ? { sha_key } : {}),
        ...((body as any).wallet_mode !== undefined
          ? { wallet_mode: (body as any).wallet_mode }
          : {}),
        ...((body as any).wallet_base_url !== undefined
          ? {
              wallet_base_url: (body as any).wallet_base_url
                ? (body as any).wallet_base_url.trim()
                : null,
            }
          : {}),
        ...((body as any).player_token_secret !== undefined
          ? {
              player_token_secret: (body as any).player_token_secret
                ? (body as any).player_token_secret.trim()
                : null,
            }
          : {}),
        ...((body as any).allowed_origins !== undefined
          ? {
              allowed_origins: (body as any).allowed_origins
                ? (body as any).allowed_origins.trim()
                : null,
            }
          : {}),
        ...(body.status !== undefined
          ? { status: body.status === 'disabled' ? PlatformAppStatus.disabled : PlatformAppStatus.active }
          : {}),
      },
      select: platformAppSelect,
    });

    await writeAdminAudit(tx, context, {
      action: 'platform_app.update',
      entity_type: 'platform_app',
      entity_id: updated.id,
      old_values: {
        app_name: existing.app_name,
        package_name: existing.package_name,
        sha_key: existing.sha_key,
        status: existing.status,
      },
      new_values: {
        app_name: updated.app_name,
        package_name: updated.package_name,
        sha_key: updated.sha_key,
        status: updated.status,
      },
    });

    return updated;
  });

  return serializePlatformApp(app);
};

const deletePlatformApp = async (app_id: string, context: AdminAuditContext) => {
  const existing = await findPlatformAppOrThrow(app_id);

  await prisma.$transaction(async (tx) => {
    await tx.platformApp.delete({ where: { id: app_id } });
    await writeAdminAudit(tx, context, {
      action: 'platform_app.delete',
      entity_type: 'platform_app',
      entity_id: app_id,
      old_values: {
        app_name: existing.app_name,
        package_name: existing.package_name,
        sha_key: existing.sha_key,
        status: existing.status,
      },
    });
  });
};

const regenerateSigningSecret = async (
  admin: AuthenticatedAdmin,
  app_id: string,
  context: AdminAuditContext,
) => {
  const existing = await prisma.platformApp.findUnique({
    where: { id: app_id },
    select: platformAppSelect,
  });
  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Platform app not found');
  }

  const signing_secret = generatePlatformSigningSecret();
  const updated = await prisma.$transaction(async (tx) => {
    const app = await tx.platformApp.update({
      where: { id: app_id },
      data: {
        signing_secret_previous: existing.signing_secret,
        signing_secret: signing_secret,
      },
      select: platformAppSelect,
    });

    await writeAdminAudit(tx, context, {
      action: 'platform_app.signing_secret.regenerate',
      entity_type: 'platform_app',
      entity_id: app.id,
      old_values: {
        signing_secret_preview: maskSigningSecret(existing.signing_secret),
      },
      new_values: {
        signing_secret_preview: maskSigningSecret(signing_secret),
        rotated_by_admin_id: admin.id,
      },
    });

    return app;
  });

  return serializePlatformApp(updated, { reveal_signing_secret: true });
};

const testWalletIntegration = async (app_id: string, test_user_id?: string) => {
  const app = await findPlatformAppOrThrow(app_id);
  return SeamlessWalletClient.testRemoteWalletIntegration(
    app,
    test_user_id || '1',
  );
};

const generateTestLaunchUrl = async (
  app_id: string,
  options: { game?: string; user_id?: string; username?: string } = {},
) => {
  const app = await findPlatformAppOrThrow(app_id);
  const secret = app.player_token_secret || app.signing_secret;
  const userId = options.user_id || 'test_player_1';
  const username = options.username || 'Test Player';

  const token = signPlayerToken(
    {
      sub: userId,
      app: app.app_key || app.package_name,
      username,
    },
    secret,
    15 * 60,
  );

  const game = options.game || 'monk-wheel';
  const path =
    game === 'teen-patti'
      ? '/games/teen-patti'
      : game === 'greedy-classic'
        ? '/games/greedy-classic'
        : game === 'lucky-77'
          ? '/games/lucky-77'
          : game === 'greedy'
            ? '/games/greedy'
            : '/games/monk-wheel';

  const url = new URL(path, `${config.game_frontend_url}/`);
  url.searchParams.set('token', token);
  url.searchParams.set('app', app.app_key || app.package_name);
  url.searchParams.set('game', game);

  return {
    launch_url: url.toString(),
    token,
    app_key: app.app_key || app.package_name,
    game,
  };
};

const PlatformAppService = {
  listPlatformApps,
  getPlatformApp,
  createPlatformApp,
  updatePlatformApp,
  deletePlatformApp,
  regenerateSigningSecret,
  testWalletIntegration,
  generateTestLaunchUrl,
};

export default PlatformAppService;
