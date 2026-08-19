import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';

const allowedPaths = new Set(['/auth/me', '/auth/logout', '/auth/password/change']);

export const adminPasswordGate = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.admin?.force_password_change && !allowedPaths.has(req.path)) {
    next(new AppError(httpStatus.FORBIDDEN, 'Change the temporary admin password before continuing'));
    return;
  }
  next();
};

export default adminPasswordGate;

