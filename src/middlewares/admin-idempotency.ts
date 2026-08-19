import type { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import { IdempotencyStatus, Prisma } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { sha256, stableRequestHash } from '@/utils/hash';

const keyHeader = 'idempotency-key';

/**
 * Requires and persists an idempotency key for an authenticated admin mutation.
 * Completed responses are replayed; failed responses can be retried with the
 * same key and a different request can never reuse an existing key.
 */
export const requireAdminIdempotency = (scope: string) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.admin) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin authentication is required');
    const key = req.header(keyHeader)?.trim();
    if (!key || key.length > 128) throw new AppError(httpStatus.BAD_REQUEST, 'Idempotency-Key header is required');
    const request_hash = stableRequestHash({
      method: req.method,
      path: req.originalUrl.split('?')[0],
      body: req.body,
      file: req.file ? { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, sha256: sha256(req.file.buffer) } : undefined,
    });
    const existing = await prisma.adminIdempotencyRecord.findUnique({ where: { admin_user_id_scope_idempotency_key: { admin_user_id: req.admin.id, scope, idempotency_key: key } } });
    if (existing) {
      if (existing.request_hash !== request_hash) throw new AppError(httpStatus.CONFLICT, 'Idempotency key was already used for another request');
      if ((existing.status === IdempotencyStatus.completed || existing.status === IdempotencyStatus.failed) && existing.response_body) {
        res.status(existing.http_status || httpStatus.OK).json(existing.response_body);
        return;
      }
      if (existing.status === IdempotencyStatus.processing) throw new AppError(httpStatus.CONFLICT, 'The same admin request is already being processed');
      throw new AppError(httpStatus.CONFLICT, 'The idempotent request has a terminal result; use a new key for a new operation');
    } else {
      await prisma.adminIdempotencyRecord.create({ data: { admin_user_id: req.admin.id, scope, idempotency_key: key, request_hash, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      // Restore Express' sender immediately so persistence failures can flow to
      // the normal error handler without recursively intercepting its response.
      res.json = originalJson;
      void prisma.adminIdempotencyRecord.update({
        where: { admin_user_id_scope_idempotency_key: { admin_user_id: req.admin!.id, scope, idempotency_key: key } },
        data: { status: res.statusCode >= 400 ? IdempotencyStatus.failed : IdempotencyStatus.completed, http_status: res.statusCode, response_body: body as Prisma.InputJsonValue },
      }).then(() => originalJson(body)).catch(next);
      return res;
    }) as Response['json'];
    next();
  } catch (error) {
    next(error);
  }
};
