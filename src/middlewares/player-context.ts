import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import config from '@/config';
import AppError from '@/errors/app-error';

/**
 * Integration seam for the platform auth system.
 * In development x-user-id is allowed only when ALLOW_DEV_IDENTITY_HEADER=true.
 * Replace/extend this middleware later to read the authenticated platform user id.
 */
const playerContext = (req: Request, _res: Response, next: NextFunction) => {
  const header_user_id = req.header('x-user-id')?.trim();

  if (config.allow_dev_identity_header && header_user_id) {
    req.game_user_id = header_user_id;
    return next();
  }

  throw new AppError(
    httpStatus.UNAUTHORIZED,
    'Authenticated player identity is required',
  );
};

export default playerContext;
