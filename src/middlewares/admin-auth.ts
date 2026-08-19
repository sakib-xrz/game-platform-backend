import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import { AdminStatus } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { hashSessionToken } from '@/modules/admin/admin.crypto';

const bearerToken = (req: Request): string | undefined => {
  const header = req.header('authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && typeof token === 'string' && token.length >= 20 ? token : undefined;
};

export const adminAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = bearerToken(req);
    if (!token) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin authentication is required');
    const now = new Date();
    const session = await prisma.adminSession.findUnique({ where: { token_hash: hashSessionToken(token) }, include: { admin_user: true } });
    if (!session || session.revoked_at || session.idle_expires_at <= now || session.absolute_expires_at <= now) {
      throw new AppError(httpStatus.UNAUTHORIZED, 'Admin session is invalid or expired');
    }
    if (session.admin_user.status !== AdminStatus.active) {
      throw new AppError(httpStatus.FORBIDDEN, 'Admin account is not active');
    }
    const idle_expires_at = new Date(Math.min(
      now.getTime() + 30 * 60 * 1000,
      session.absolute_expires_at.getTime(),
    ));
    await prisma.$transaction([
      prisma.adminSession.update({ where: { id: session.id }, data: { last_seen_at: now, idle_expires_at } }),
    ]);
    req.admin = {
      id: session.admin_user.id,
      email: session.admin_user.email,
      display_name: session.admin_user.display_name,
      role: session.admin_user.role,
      status: session.admin_user.status,
      force_password_change: session.admin_user.force_password_change,
    };
    req.admin_session_id = session.id;
    next();
  } catch (error) {
    next(error);
  }
};

export default adminAuth;
