import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import { PlatformAppStatus } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import {
  normalizePackageName,
  normalizeShaKey,
} from '@/modules/platform-app/platform-app.validation';

export type AuthenticatedPlatformApp = {
  id: string;
  app_name: string;
  package_name: string;
  sha_key: string;
  status: PlatformAppStatus;
};

const readCredential = (req: Request, header: string, bodyKey: string): string | undefined => {
  const header_value = req.header(header)?.trim();
  if (header_value) return header_value;
  const body_value = req.body?.[bodyKey];
  return typeof body_value === 'string' ? body_value.trim() : undefined;
};

const platformAppAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const app_name = readCredential(req, 'x-app-name', 'app_name');
  const package_name_raw = readCredential(req, 'x-package-name', 'package_name');
  const sha_key_raw = readCredential(req, 'x-sha-key', 'sha_key');

  if (!app_name || !package_name_raw || !sha_key_raw) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      'Platform app credentials are required (X-App-Name, X-Package-Name, X-Sha-Key)',
    );
  }

  const package_name = normalizePackageName(package_name_raw);
  const sha_key = normalizeShaKey(sha_key_raw);

  const app = await prisma.platformApp.findUnique({
    where: { package_name },
    select: {
      id: true,
      app_name: true,
      package_name: true,
      sha_key: true,
      status: true,
    },
  });

  if (!app || app.sha_key !== sha_key) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid platform app credentials');
  }

  if (app.app_name.trim().toLowerCase() !== app_name.trim().toLowerCase()) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Platform app name does not match registered app');
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
