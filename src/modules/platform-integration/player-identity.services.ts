import httpStatus from 'http-status';
import {
  PlatformAppStatus,
  PlatformUserStatus,
  Prisma,
  type PlatformApp,
  type PlatformUser,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import config from '@/config';
import prisma from '@/lib/prisma';
import {
  verifyPlayerToken,
  type PlayerTokenClaims,
} from '@/utils/player-token';
import { logger } from '@/utils/logger';

/**
 * Host-app player identity.
 *
 * A host app launches a game with a signed player token whose `sub` is the
 * host's own user id (e.g. "3"). Games, wallets and sockets are keyed by our
 * internal PlatformUser id, so every request carrying that token must be
 * mapped (app, sub) -> PlatformUser.id. Using the raw `sub` as the game user
 * id puts the player on an empty local wallet instead of their host balance.
 */

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

export const playerTokenSecrets = (app: PlatformApp): string[] =>
  [app.player_token_secret, app.signing_secret, app.signing_secret_previous].filter(
    Boolean,
  ) as string[];

/** Reads the `app` claim without verifying; the signature is checked afterwards. */
export const readUnverifiedAppClaim = (token: string): string | undefined => {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const claims = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return typeof claims?.app === 'string' ? claims.app : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Create or refresh the PlatformUser for a verified token. Safe under
 * concurrent first requests (session verify, snapshot, socket) for the same
 * player: a unique-constraint race falls back to reading the winner's row.
 */
export const upsertPlatformPlayer = async (
  app: Pick<PlatformApp, 'id' | 'package_name'>,
  claims: Pick<PlayerTokenClaims, 'sub' | 'username' | 'avatarUrl'>,
): Promise<{ user: PlatformUser; created: boolean }> => {
  const externalUserId = claims.sub.trim();
  const displayName =
    claims.username?.trim() || `Player ${externalUserId.slice(-4)}`;
  const photoUrl = claims.avatarUrl?.trim() || null;
  const where = {
    platform_app_id_external_user_id: {
      platform_app_id: app.id,
      external_user_id: externalUserId,
    },
  };

  const existing = await prisma.platformUser.findUnique({ where });
  if (existing) {
    const changed =
      existing.display_name !== displayName ||
      existing.photo_url !== photoUrl ||
      existing.status !== PlatformUserStatus.active;
    const user = changed
      ? await prisma.platformUser.update({
          where: { id: existing.id },
          data: {
            display_name: displayName,
            photo_url: photoUrl,
            status: PlatformUserStatus.active,
          },
        })
      : existing;
    return { user, created: false };
  }

  try {
    const user = await prisma.platformUser.create({
      data: {
        platform_app_id: app.id,
        external_user_id: externalUserId,
        email: `${externalUserId}@${app.package_name}.platform`.toLowerCase(),
        display_name: displayName,
        photo_url: photoUrl,
        status: PlatformUserStatus.active,
      },
    });
    return { user, created: true };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const user = await prisma.platformUser.findUnique({ where });
      if (user) return { user, created: false };
    }
    throw err;
  }
};

export type ResolvedTokenPlayer = {
  userId: string;
  externalUserId: string;
  app: PlatformApp;
  /** True only when this call created the PlatformUser. */
  created: boolean;
};

// Snapshots are polled through every round, so cache token -> player briefly.
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_CACHE_MAX = 20_000;
const tokenCache = new Map<
  string,
  { player: Omit<ResolvedTokenPlayer, 'created'>; expiresAt: number }
>();

export const clearPlayerTokenCache = () => tokenCache.clear();

/**
 * Verify a host-signed player token and return the internal player it
 * belongs to, creating the PlatformUser on first sight. Throws 401 when the
 * token is not valid for the app.
 */
export const resolvePlayerFromToken = async (
  token: string,
  appKeyHint?: string,
): Promise<ResolvedTokenPlayer> => {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return { ...cached.player, created: false };
  }

  const appIdentifier = readUnverifiedAppClaim(token) || appKeyHint?.trim();
  if (!appIdentifier) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Player token has no app claim');
  }

  const app = await findPlatformAppByIdentifier(appIdentifier);
  const verification = verifyPlayerToken(token, playerTokenSecrets(app), {
    expiredGraceSeconds: config.player_token_session_grace_seconds,
  });
  if (!verification.valid || !verification.claims) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      `Invalid player token: ${verification.reason || 'verification failed'}`,
    );
  }

  const { user, created } = await upsertPlatformPlayer(app, verification.claims);
  const player = {
    userId: user.id,
    externalUserId: user.external_user_id,
    app,
  };

  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    for (const [key, entry] of tokenCache) {
      if (entry.expiresAt <= now) tokenCache.delete(key);
    }
    if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  }
  tokenCache.set(token, { player, expiresAt: now + TOKEN_CACHE_TTL_MS });

  if (created) {
    logger.info('platform_player_created_from_token', {
      app_id: app.id,
      platform_user_id: user.id,
    });
  }

  return { ...player, created };
};
