import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import config from '@/config';
import AppError from '@/errors/app-error';

const adminKeyGuard = (req: Request, _res: Response, next: NextFunction) => {
  if (!config.admin_api_key) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Admin API key is not configured',
    );
  }

  if (req.header('x-admin-key') !== config.admin_api_key) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid admin API key');
  }

  next();
};

export default adminKeyGuard;
