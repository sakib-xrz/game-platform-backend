import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';
import {
  appCredentialsSchema,
  type AppCredentials,
} from '@/modules/platform-integration/platform-integration.validation';
import { resolveActivePlatformApp } from '@/modules/platform-integration/platform-integration.services';

const readHeader = (req: Request, name: string): string | undefined =>
  req.header(name)?.trim() || undefined;

/**
 * Simple shared-secret auth for server-to-server coin APIs.
 * Expects: X-App-Name, X-Package-Name, X-Sha-Key
 */
const platformAppCredentials = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const credentials_raw = {
      app_name: readHeader(req, 'x-app-name'),
      package_name: readHeader(req, 'x-package-name'),
      sha_key: readHeader(req, 'x-sha-key'),
    };

    if (
      !credentials_raw.app_name ||
      !credentials_raw.package_name ||
      !credentials_raw.sha_key
    ) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        'Platform integration requires X-App-Name, X-Package-Name, and X-Sha-Key headers',
      );
    }

    let credentials: AppCredentials;
    try {
      credentials = appCredentialsSchema.parse(credentials_raw);
    } catch {
      throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid app credentials');
    }

    req.platform_app = await resolveActivePlatformApp(credentials);
    next();
  } catch (error) {
    next(error);
  }
};

export default platformAppCredentials;
