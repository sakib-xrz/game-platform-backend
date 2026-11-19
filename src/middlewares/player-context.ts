import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import config from '@/config';
import AppError from '@/errors/app-error';
import { resolvePlayerFromToken } from '@/modules/platform-integration/player-identity.services';
import {
  getUserWalletContext,
  syncSeamlessUserBalance,
} from '@/modules/platform-integration/seamless-wallet.services';
import { logger } from '@/utils/logger';

/**
 * Resolve the internal game user id for a request or socket handshake.
 *
 * 1. Host-signed player token (X-Player-Token): verified against the host
 *    app's secrets and mapped (app, sub) -> PlatformUser.id. This is how host
 *    app players (seamless wallet) are identified.
 * 2. Legacy X-User-Id header, only when ALLOW_DEV_IDENTITY_HEADER=true. It is
 *    refused for players linked to a seamless host wallet: an unsigned header
 *    must never be able to spend a host app user's coins.
 *
 * Returns undefined when no identity was supplied.
 */
export const resolvePlayerIdentity = async (input: {
  token?: string;
  appKey?: string;
  headerUserId?: string;
}): Promise<string | undefined> => {
  const token = input.token?.trim();
  if (token) {
    const player = await resolvePlayerFromToken(token, input.appKey);
    if (player.created) {
      // Player reached a game before session verify ran: pull their host
      // balance now so the first snapshot is not stuck on an empty wallet.
      syncSeamlessUserBalance(player.userId).catch((err) => {
        logger.warn('seamless_balance_sync_failed', {
          platform_user_id: player.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return player.userId;
  }

  const headerUserId = input.headerUserId?.trim();
  if (headerUserId && config.allow_dev_identity_header) {
    const walletContext = await getUserWalletContext(headerUserId);
    if (walletContext.isSeamless) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        'Player token is required for host app players',
      );
    }
    return headerUserId;
  }

  return undefined;
};

const readRequestIdentity = (req: Request) => ({
  token: req.header('x-player-token'),
  appKey: req.header('x-app-key'),
  headerUserId: req.header('x-user-id'),
});

const playerContext = (req: Request, _res: Response, next: NextFunction) => {
  resolvePlayerIdentity(readRequestIdentity(req))
    .then((userId) => {
      if (!userId) {
        throw new AppError(
          httpStatus.UNAUTHORIZED,
          'Authenticated player identity is required',
        );
      }
      req.game_user_id = userId;
      next();
    })
    .catch(next);
};

/** Public routes: attach the player when identifiable, never reject. */
export const optionalPlayerContext = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  resolvePlayerIdentity(readRequestIdentity(req))
    .then((userId) => {
      if (userId) req.game_user_id = userId;
    })
    .catch(() => undefined)
    .finally(() => next());
};

export default playerContext;
