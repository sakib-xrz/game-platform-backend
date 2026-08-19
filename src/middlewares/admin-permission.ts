import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';
import type { AdminPermission } from '@/modules/admin/admin.permissions';
import { hasAdminPermission } from '@/modules/admin/admin.permissions';

export const requireAdminPermission = (permission: AdminPermission) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.admin) {
      next(new AppError(httpStatus.UNAUTHORIZED, 'Admin authentication is required'));
      return;
    }
    if (!hasAdminPermission(req.admin.role, permission)) {
      next(new AppError(httpStatus.FORBIDDEN, 'Insufficient admin permission'));
      return;
    }
    next();
  };

