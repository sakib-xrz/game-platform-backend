import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import { PlatformAppStatus } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { normalizePackageName } from '@/modules/platform-app/platform-app.validation';
import {
  assertPlatformTimestampFresh,
  parsePlatformTimestamp,
  verifyPlatformRequestSignature,
} from '@/utils/platform-signature';

export type AuthenticatedPlatformApp = {
  id: string;
  app_name: string;
  package_name: string;
  sha_key: string;
  status: PlatformAppStatus;
};

const readHeader = (req: Request, name: string): string | undefined =>
  req.header(name)?.trim() || undefined;

const resolveRequestPath = (req: Request): string => {
  const original = req.originalUrl.split('?')[0] || req.path;
  return original.startsWith('/') ? original : `/${original}`;
};

const resolveRawBody = (req: Request): Buffer => {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  if (req.body && Object.keys(req.body).length > 0) {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  return Buffer.alloc(0);
};

const verifySignatureForSecret = (
  secret: string,
  signature: string,
  req: Request,
  timestamp: string,
): boolean =>
  verifyPlatformRequestSignature(secret, signature, {
    timestamp,
    method: req.method,
    path: resolveRequestPath(req),
    raw_body: resolveRawBody(req),
  });

const platformAppAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const package_name_raw = readHeader(req, 'x-app-package') || readHeader(req, 'x-package-name');
  const timestamp = readHeader(req, 'x-timestamp');
  const signature = readHeader(req, 'x-signature');

  if (!package_name_raw || !timestamp || !signature) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      'Platform integration requires X-App-Package, X-Timestamp, and X-Signature headers',
    );
  }

  const timestamp_ms = parsePlatformTimestamp(timestamp);
  if (timestamp_ms === null) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'X-Timestamp must be a unix timestamp');
  }

  try {
    assertPlatformTimestampFresh(timestamp_ms);
  } catch {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Platform request timestamp is expired or too far in the future');
  }

  const package_name = normalizePackageName(package_name_raw);
  const app = await prisma.platformApp.findUnique({
    where: { package_name },
    select: {
      id: true,
      app_name: true,
      package_name: true,
      sha_key: true,
      signing_secret: true,
      signing_secret_previous: true,
      status: true,
    },
  });

  if (!app) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Unknown platform app package');
  }

  const signature_valid =
    verifySignatureForSecret(app.signing_secret, signature, req, timestamp)
    || (app.signing_secret_previous
      ? verifySignatureForSecret(app.signing_secret_previous, signature, req, timestamp)
      : false);

  if (!signature_valid) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid platform request signature');
  }

  if (app.status !== PlatformAppStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform app is disabled');
  }

  req.platform_app = {
    id: app.id,
    app_name: app.app_name,
    package_name: app.package_name,
    sha_key: app.sha_key,
    status: app.status,
  };

  next();
};

export default platformAppAuth;
