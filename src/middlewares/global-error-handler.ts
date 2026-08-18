import { ErrorRequestHandler } from 'express';
import { Prisma } from '@/generated/prisma/client';
import { ZodError } from 'zod';
import config from '@/config';
import AppError from '@/errors/app-error';
import { logger } from '@/utils/logger';

const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let statusCode = 500;
  let message = config.node_env === 'production' ? 'Unexpected server error' : String(err?.message || err);
  let errors: string[] | undefined;

  if (err instanceof ZodError) {
    statusCode = 400;
    message = 'Validation failed';
    errors = err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    if (Array.isArray(err.errors)) errors = err.errors;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      statusCode = 409;
      message = 'A unique constraint was violated';
    }
  }

  logger.error('request_failed', {
    method: req.method,
    path: req.originalUrl,
    statusCode,
    request_id: req.request_id,
    error: err instanceof Error ? err.stack : err,
  });

  res.status(statusCode).json({
    success: false,
    statusCode,
    message,
    ...(errors ? { errors } : {}),
    ...(config.node_env !== 'production' && err instanceof Error
      ? { stack: err.stack }
      : {}),
    timestamp: new Date().toISOString(),
  });
};

export default globalErrorHandler;
