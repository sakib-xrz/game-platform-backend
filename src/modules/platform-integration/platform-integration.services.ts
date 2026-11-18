import httpStatus from 'http-status';
import {
  AuditActorType,
  PlatformAppStatus,
  PlatformUserStatus,
  Prisma,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import config from '@/config';
import prisma from '@/lib/prisma';
import {
  normalizePackageName,
  normalizeShaKey,
} from '@/modules/platform-app/platform-app.validation';
import {
  creditPlatformPurchase,
  debitPlatformWithdrawal,
  ensureWallet,
} from '@/modules/wallet/wallet.services';
import { signPlayerToken, verifyPlayerToken } from '@/utils/player-token';
import { SeamlessWalletClient } from './seamless-wallet.client';
import { syncSeamlessUserBalance } from './seamless-wallet.services';
import type {
  AppCredentials,
  CreditPlatformUserCoinsBody,
  GetGamesQuery,
  LaunchGameBody,
  SyncBalanceBody,
  SyncPlatformUserBody,
  VerifySessionBody,
  WithdrawPlatformUserCoinsBody,
} from './platform-integration.validation';

const DEFAULT_CURRENCY_CODE = 'COIN';

export type PlatformAppContext = {
  id: string;
  app_name: string;
  package_name: string;
  sha_key: string;
  status: PlatformAppStatus;
};

export const resolveActivePlatformApp = async (
  credentials: AppCredentials,
): Promise<PlatformAppContext> => {
  const package_name = normalizePackageName(credentials.package_name);
  const sha_key = normalizeShaKey(credentials.sha_key);
  const app_name = credentials.app_name.trim();

  const app = await prisma.platformApp.findUnique({
    where: { package_name },
    select: {
      id: true,
      app_name: true,
      package_name: true,
      sha_key: true,
      status: true,
    },
  });

  if (!app) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid app credentials');
  }

  const name_matches =
    app.app_name.trim().toLowerCase() === app_name.toLowerCase();
  const sha_matches = normalizeShaKey(app.sha_key) === sha_key;
  if (!name_matches || !sha_matches) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid app credentials');
  }

  if (app.status !== PlatformAppStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform app is disabled');
  }

  return app;
};

/** Safe relative path for game frontend (home or a game). */
const normalizeLaunchPath = (path?: string): string => {
  const raw = (path || '/').trim() || '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid launch path');
  }
  return raw;
};

export const buildLaunchUrl = (user_id: string, path = '/'): string => {
  const launch_path = normalizeLaunchPath(path);
  const url = new URL(launch_path, `${config.game_frontend_url}/`);
  url.searchParams.set('user', user_id);
  return url.toString();
};

const platformUserSelect = {
  id: true,
  platform_app_id: true,
  external_user_id: true,
  email: true,
  display_name: true,
  photo_url: true,
  status: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.PlatformUserSelect;

const writePlatformAudit = async (
  tx: Prisma.TransactionClient,
  platform_app_id: string,
  data: {
    action: string;
    entity_type: string;
    entity_id?: string;
    old_values?: Prisma.InputJsonValue;
    new_values?: Prisma.InputJsonValue;
    request_id?: string;
  },
) => {
  await tx.auditLog.create({
    data: {
      actor_type: AuditActorType.system,
      actor_id: platform_app_id,
      outcome: 'success',
      action: data.action,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      old_values: data.old_values,
      new_values: data.new_values,
      request_id: data.request_id,
    },
  });
};

const getWalletBalance = async (
  user_id: string,
  tx: Prisma.TransactionClient = prisma,
) => {
  const wallet = await ensureWallet(user_id, tx);
  return wallet.balance;
};

const serializeUserResponse = (
  user: Prisma.PlatformUserGetPayload<{ select: typeof platformUserSelect }>,
  balance: bigint,
  created: boolean,
) => ({
  user_id: user.id,
  external_user_id: user.external_user_id,
  email: user.email,
  name: user.display_name,
  photo_url: user.photo_url,
  balance: balance.toString(),
  currency: DEFAULT_CURRENCY_CODE,
  created,
  /** Open this once in the WebView — identity is kept for all games. */
  launch_url: buildLaunchUrl(user.id, '/'),
});

const findPlatformUserOrThrow = async (
  platform_app: PlatformAppContext,
  external_user_id: string,
) => {
  const user = await prisma.platformUser.findUnique({
    where: {
      platform_app_id_external_user_id: {
        platform_app_id: platform_app.id,
        external_user_id,
      },
    },
    select: platformUserSelect,
  });
  if (!user) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      'Platform user not found for this app',
    );
  }
  return user;
};

const syncPlatformUser = async (
  body: SyncPlatformUserBody,
  request_id?: string,
) => {
  const platform_app = await resolveActivePlatformApp(body);
  const external_user_id = body.external_user_id.trim();
  const email = body.email.trim().toLowerCase();
  const display_name = body.name.trim();
  const photo_url = body.photo_url?.trim() || null;

  const existing = await prisma.platformUser.findUnique({
    where: {
      platform_app_id_external_user_id: {
        platform_app_id: platform_app.id,
        external_user_id,
      },
    },
    select: platformUserSelect,
  });

  if (existing) {
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.platformUser.update({
        where: { id: existing.id },
        data: {
          email,
          display_name,
          photo_url,
        },
        select: platformUserSelect,
      });
      const balance = await getWalletBalance(updated.id, tx);
      await writePlatformAudit(tx, platform_app.id, {
        action: 'platform_user.sync',
        entity_type: 'platform_user',
        entity_id: updated.id,
        request_id,
        old_values: {
          email: existing.email,
          name: existing.display_name,
          photo_url: existing.photo_url,
        },
        new_values: {
          email: updated.email,
          name: updated.display_name,
          photo_url: updated.photo_url,
        },
      });
      return { user: updated, balance, created: false };
    });

    return serializeUserResponse(result.user, result.balance, result.created);
  }

  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.platformUser.create({
      data: {
        platform_app_id: platform_app.id,
        external_user_id,
        email,
        display_name,
        photo_url,
        status: PlatformUserStatus.active,
      },
      select: platformUserSelect,
    });
    const balance = await getWalletBalance(created.id, tx);
    await writePlatformAudit(tx, platform_app.id, {
      action: 'platform_user.sync',
      entity_type: 'platform_user',
      entity_id: created.id,
      request_id,
      new_values: {
        external_user_id,
        email,
        name: display_name,
        photo_url,
        balance: balance.toString(),
      },
    });
    return { user: created, balance, created: true };
  });

  return serializeUserResponse(result.user, result.balance, result.created);
};

const getPlatformUserCoins = async (
  credentials: AppCredentials,
  external_user_id: string,
) => {
  const platform_app = await resolveActivePlatformApp(credentials);
  const user = await findPlatformUserOrThrow(
    platform_app,
    external_user_id.trim(),
  );
  const balance = await getWalletBalance(user.id);
  return {
    user_id: user.id,
    external_user_id: user.external_user_id,
    balance: balance.toString(),
    currency: DEFAULT_CURRENCY_CODE,
    launch_url: buildLaunchUrl(user.id, '/'),
  };
};

const launchPlatformUser = async (
  credentials: AppCredentials,
  external_user_id: string,
  path?: string,
) => {
  const platform_app = await resolveActivePlatformApp(credentials);
  const user = await findPlatformUserOrThrow(
    platform_app,
    external_user_id.trim(),
  );
  if (user.status !== PlatformUserStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform user is disabled');
  }
  return {
    user_id: user.id,
    external_user_id: user.external_user_id,
    launch_url: buildLaunchUrl(user.id, path),
  };
};

const creditPlatformUserCoins = async (
  platform_app: PlatformAppContext,
  body: CreditPlatformUserCoinsBody,
  request_id?: string,
) => {
  const external_user_id = body.external_user_id.trim();
  const amount = BigInt(body.amount);
  const client_request_id = body.client_request_id.trim();

  const user = await findPlatformUserOrThrow(platform_app, external_user_id);
  if (user.status !== PlatformUserStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform user is disabled');
  }

  const existing_deposit = await prisma.platformCoinDeposit.findUnique({
    where: {
      platform_app_id_client_request_id: {
        platform_app_id: platform_app.id,
        client_request_id,
      },
    },
    include: {
      wallet_ledger: {
        select: {
          balance_after: true,
        },
      },
    },
  });

  if (existing_deposit) {
    if (existing_deposit.external_user_id !== external_user_id) {
      throw new AppError(
        httpStatus.CONFLICT,
        'client_request_id belongs to another user',
      );
    }
    return {
      external_user_id,
      received_amount: existing_deposit.received_amount.toString(),
      converted_amount: existing_deposit.converted_amount.toString(),
      balance: existing_deposit.wallet_ledger.balance_after.toString(),
      currency: DEFAULT_CURRENCY_CODE,
      idempotent: true,
    };
  }

  return prisma.$transaction(
    async (tx) => {
      const { ledger, balance_after } = await creditPlatformPurchase(tx, {
        user_id: user.id,
        amount,
        reference_type: 'platform_coin_deposit',
        reference_id: client_request_id,
        metadata: {
          platform_app_id: platform_app.id,
          external_user_id,
          client_request_id,
          received_amount: amount.toString(),
          converted_amount: amount.toString(),
        },
      });

      const deposit = await tx.platformCoinDeposit.create({
        data: {
          platform_app_id: platform_app.id,
          platform_user_id: user.id,
          external_user_id,
          client_request_id,
          received_amount: amount,
          converted_amount: amount,
          wallet_ledger_id: ledger.id,
        },
      });

      await writePlatformAudit(tx, platform_app.id, {
        action: 'platform_user.coin_credit',
        entity_type: 'platform_coin_deposit',
        entity_id: deposit.id,
        request_id,
        new_values: {
          external_user_id,
          received_amount: amount.toString(),
          converted_amount: amount.toString(),
          balance: balance_after.toString(),
          client_request_id,
        },
      });

      return {
        external_user_id,
        received_amount: amount.toString(),
        converted_amount: amount.toString(),
        balance: balance_after.toString(),
        currency: DEFAULT_CURRENCY_CODE,
        idempotent: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

const withdrawPlatformUserCoins = async (
  platform_app: PlatformAppContext,
  body: WithdrawPlatformUserCoinsBody,
  request_id?: string,
) => {
  const external_user_id = body.external_user_id.trim();
  const amount = BigInt(body.amount);
  const client_request_id = body.client_request_id.trim();

  const user = await findPlatformUserOrThrow(platform_app, external_user_id);
  if (user.status !== PlatformUserStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform user is disabled');
  }

  const existing_withdrawal = await prisma.platformCoinWithdrawal.findUnique({
    where: {
      platform_app_id_client_request_id: {
        platform_app_id: platform_app.id,
        client_request_id,
      },
    },
    include: {
      wallet_ledger: {
        select: {
          balance_after: true,
        },
      },
    },
  });

  if (existing_withdrawal) {
    if (existing_withdrawal.external_user_id !== external_user_id) {
      throw new AppError(
        httpStatus.CONFLICT,
        'client_request_id belongs to another user',
      );
    }
    return {
      external_user_id,
      requested_amount: existing_withdrawal.requested_amount.toString(),
      transferred_amount: existing_withdrawal.transferred_amount.toString(),
      balance: existing_withdrawal.wallet_ledger.balance_after.toString(),
      currency: DEFAULT_CURRENCY_CODE,
      idempotent: true,
    };
  }

  const current_balance = await getWalletBalance(user.id);
  if (current_balance < amount) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Insufficient wallet balance for withdrawal',
      {
        balance: [current_balance.toString()],
        requested_amount: [amount.toString()],
        shortfall: [(amount - current_balance).toString()],
        currency: [DEFAULT_CURRENCY_CODE],
      },
    );
  }

  return prisma.$transaction(
    async (tx) => {
      const { ledger, balance_after } = await debitPlatformWithdrawal(tx, {
        user_id: user.id,
        amount,
        reference_type: 'platform_coin_withdrawal',
        reference_id: client_request_id,
        metadata: {
          platform_app_id: platform_app.id,
          external_user_id,
          client_request_id,
          requested_amount: amount.toString(),
          transferred_amount: amount.toString(),
        },
      });

      const withdrawal = await tx.platformCoinWithdrawal.create({
        data: {
          platform_app_id: platform_app.id,
          platform_user_id: user.id,
          external_user_id,
          client_request_id,
          requested_amount: amount,
          transferred_amount: amount,
          wallet_ledger_id: ledger.id,
        },
      });

      await writePlatformAudit(tx, platform_app.id, {
        action: 'platform_user.coin_withdraw',
        entity_type: 'platform_coin_withdrawal',
        entity_id: withdrawal.id,
        request_id,
        new_values: {
          external_user_id,
          requested_amount: amount.toString(),
          transferred_amount: amount.toString(),
          balance: balance_after.toString(),
          client_request_id,
        },
      });

      return {
        external_user_id,
        requested_amount: amount.toString(),
        transferred_amount: amount.toString(),
        balance: balance_after.toString(),
        currency: DEFAULT_CURRENCY_CODE,
        idempotent: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

export const findPlatformAppByIdentifier = async (identifier: string) => {
  const trimmed = identifier.trim();
  const app = await prisma.platformApp.findFirst({
    where: {
      OR: [
        { app_key: trimmed },
        { package_name: trimmed },
        { id: trimmed },
      ],
    },
  });

  if (!app) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      `Platform app not found for identifier "${identifier}"`,
    );
  }

  if (app.status !== PlatformAppStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform app is disabled');
  }

  return app;
};

const GAME_DEFINITIONS = [
  {
    gameKey: 'monk-wheel',
    name: 'Monk Wheel',
    description: 'High-octane wheel of fortune with up to 20x multipliers and jackpot bonuses.',
    path: '/games/monk-wheel',
    iconUrl: `${config.game_frontend_url}/icons/monk-wheel.png`,
  },
  {
    gameKey: 'teen-patti',
    name: 'Teen Patti Classic',
    description: 'Authentic 3-card poker table with real-time multiplayer action.',
    path: '/games/teen-patti',
    iconUrl: `${config.game_frontend_url}/icons/teen-patti.png`,
  },
  {
    gameKey: 'greedy-classic',
    name: 'Greedy Classic',
    description: 'Classic wheel betting experience with proven player retention.',
    path: '/games/greedy-classic',
    iconUrl: `${config.game_frontend_url}/icons/greedy-classic.png`,
  },
  {
    gameKey: 'lucky-77',
    name: 'Lucky 77',
    description: 'Fast-paced high-low prediction card showdown.',
    path: '/games/lucky-77',
    iconUrl: `${config.game_frontend_url}/icons/lucky-77.png`,
  },
];

const getGameCatalog = async (appIdentifier: string) => {
  const app = await findPlatformAppByIdentifier(appIdentifier);
  const frontendBase = config.game_frontend_url;

  return {
    app: {
      id: app.id,
      name: app.app_name,
      appKey: app.app_key || app.package_name,
      packageName: app.package_name,
      walletMode: app.wallet_mode,
      allowedOrigins: app.allowed_origins || '*',
    },
    games: GAME_DEFINITIONS.map((g) => ({
      gameKey: g.gameKey,
      name: g.name,
      description: g.description,
      launchUrl: `${frontendBase}${g.path}`,
      iconUrl: g.iconUrl,
    })),
  };
};

const verifySession = async (body: VerifySessionBody) => {
  const { token, appKey } = body;

  // 1. Decode JWT payload unverified to discover target app if appKey is not passed
  let targetAppIdentifier = appKey;
  if (!targetAppIdentifier) {
    try {
      const parts = token.split('.');
      if (parts.length === 3 && parts[1]) {
        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        const claims = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
        targetAppIdentifier = claims.app;
      }
    } catch {
      // Handled below
    }
  }

  if (!targetAppIdentifier) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'appKey is required or must be present in token app claim',
    );
  }

  const app = await findPlatformAppByIdentifier(targetAppIdentifier);

  // 2. Validate token against configured secrets
  const secrets = [
    app.player_token_secret,
    app.signing_secret,
    app.signing_secret_previous,
  ].filter(Boolean) as string[];

  const verification = verifyPlayerToken(token, secrets);
  if (!verification.valid || !verification.claims) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      `Invalid or expired player token: ${verification.reason || 'Verification failed'}`,
    );
  }

  const claims = verification.claims;
  const externalUserId = claims.sub.trim();
  const displayName = claims.username?.trim() || `Player ${externalUserId.slice(-4)}`;
  const photoUrl = claims.avatarUrl?.trim() || null;
  const email = `${externalUserId}@${app.package_name}.platform`.toLowerCase();

  // 3. Upsert PlatformUser record
  const user = await prisma.platformUser.upsert({
    where: {
      platform_app_id_external_user_id: {
        platform_app_id: app.id,
        external_user_id: externalUserId,
      },
    },
    update: {
      display_name: displayName,
      photo_url: photoUrl,
      status: PlatformUserStatus.active,
    },
    create: {
      platform_app_id: app.id,
      external_user_id: externalUserId,
      email,
      display_name: displayName,
      photo_url: photoUrl,
      status: PlatformUserStatus.active,
    },
  });

  // 4. Ensure wallet & sync balance
  let balance = 0n;
  if (app.wallet_mode === 'seamless') {
    try {
      balance = await SeamlessWalletClient.getRemoteBalance(app, externalUserId);
      const wallet = await ensureWallet(user.id);
      await prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance, version: { increment: 1 } },
      });
    } catch (err: any) {
      // In case host app is unreachable during boot, fallback to cached wallet balance
      const wallet = await ensureWallet(user.id);
      balance = wallet.balance;
    }
  } else {
    const wallet = await ensureWallet(user.id);
    balance = wallet.balance;
  }

  return {
    user_id: user.id,
    external_user_id: user.external_user_id,
    display_name: user.display_name,
    photo_url: user.photo_url,
    balance: balance.toString(),
    currency: DEFAULT_CURRENCY_CODE,
    wallet_mode: app.wallet_mode,
    app_key: app.app_key || app.package_name,
    app_name: app.app_name,
  };
};

const launchGame = async (body: LaunchGameBody) => {
  const app = await findPlatformAppByIdentifier(body.appKey);
  const secret = app.player_token_secret || app.signing_secret;

  const token = signPlayerToken(
    {
      sub: body.userId,
      app: app.app_key || app.package_name,
      username: body.username,
      avatarUrl: body.avatarUrl || undefined,
    },
    secret,
    15 * 60,
  );

  const fallbackGame = GAME_DEFINITIONS[0]!;
  const matchedGame = GAME_DEFINITIONS.find((g) => g.gameKey === body.game) || fallbackGame;
  const url = new URL(matchedGame.path, `${config.game_frontend_url}/`);
  url.searchParams.set('token', token);
  url.searchParams.set('app', app.app_key || app.package_name);
  url.searchParams.set('game', matchedGame.gameKey);

  return {
    launch_url: url.toString(),
    token,
    app_key: app.app_key || app.package_name,
    game: matchedGame.gameKey,
  };
};

const syncBalance = async (body: SyncBalanceBody) => {
  const balance = await syncSeamlessUserBalance(body.userId);
  return {
    user_id: body.userId,
    balance: balance.toString(),
    currency: DEFAULT_CURRENCY_CODE,
  };
};

const PlatformIntegrationService = {
  syncPlatformUser,
  getPlatformUserCoins,
  creditPlatformUserCoins,
  withdrawPlatformUserCoins,
  launchPlatformUser,
  buildLaunchUrl,
  findPlatformAppByIdentifier,
  getGameCatalog,
  verifySession,
  launchGame,
  syncBalance,
};

export default PlatformIntegrationService;
