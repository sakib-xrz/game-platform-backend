import httpStatus from 'http-status';
import { Prisma, PlatformAppStatus } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import type { AuthenticatedAdmin } from '@/modules/admin/admin.types';
import { writeAdminAudit, type AdminAuditContext } from '@/modules/admin/admin.services';
import type { CreatePlatformAppBody, UpdatePlatformAppBody } from './platform-app.validation';
import { normalizePackageName, normalizeShaKey } from './platform-app.validation';

const platformAppSelect = {
  id: true,
  app_name: true,
  package_name: true,
  sha_key: true,
  status: true,
  created_by_admin_id: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.PlatformAppSelect;

const serializePlatformApp = (
  app: Prisma.PlatformAppGetPayload<{ select: typeof platformAppSelect }>,
) => ({
  ...app,
  created_at: app.created_at.toISOString(),
  updated_at: app.updated_at.toISOString(),
});

const findPlatformAppOrThrow = async (app_id: string) => {
  const app = await prisma.platformApp.findUnique({
    where: { id: app_id },
    select: platformAppSelect,
  });
  if (!app) {
    throw new AppError(httpStatus.NOT_FOUND, 'Platform app not found');
  }
  return app;
};

const listPlatformApps = async () => {
  const apps = await prisma.platformApp.findMany({
    select: platformAppSelect,
    orderBy: [{ status: 'asc' }, { app_name: 'asc' }],
  });
  return apps.map(serializePlatformApp);
};

const getPlatformApp = async (app_id: string) =>
  serializePlatformApp(await findPlatformAppOrThrow(app_id));

const createPlatformApp = async (
  admin: AuthenticatedAdmin,
  body: CreatePlatformAppBody,
  context: AdminAuditContext,
) => {
  const package_name = normalizePackageName(body.package_name);
  const sha_key = normalizeShaKey(body.sha_key);

  const existing = await prisma.platformApp.findUnique({
    where: { package_name },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(httpStatus.CONFLICT, 'A platform app with this package name already exists');
  }

  const app = await prisma.$transaction(async (tx) => {
    const created = await tx.platformApp.create({
      data: {
        app_name: body.app_name.trim(),
        package_name,
        sha_key,
        status: body.status === 'disabled' ? PlatformAppStatus.disabled : PlatformAppStatus.active,
        created_by_admin_id: admin.id,
      },
      select: platformAppSelect,
    });

    await writeAdminAudit(tx, context, {
      action: 'platform_app.create',
      entity_type: 'platform_app',
      entity_id: created.id,
      new_values: {
        app_name: created.app_name,
        package_name: created.package_name,
        sha_key: created.sha_key,
        status: created.status,
      },
    });

    return created;
  });

  return serializePlatformApp(app);
};

const updatePlatformApp = async (
  app_id: string,
  body: UpdatePlatformAppBody,
  context: AdminAuditContext,
) => {
  const existing = await findPlatformAppOrThrow(app_id);

  const package_name = body.package_name
    ? normalizePackageName(body.package_name)
    : undefined;
  const sha_key = body.sha_key ? normalizeShaKey(body.sha_key) : undefined;

  if (package_name && package_name !== existing.package_name) {
    const conflict = await prisma.platformApp.findUnique({
      where: { package_name },
      select: { id: true },
    });
    if (conflict && conflict.id !== app_id) {
      throw new AppError(httpStatus.CONFLICT, 'A platform app with this package name already exists');
    }
  }

  const app = await prisma.$transaction(async (tx) => {
    const updated = await tx.platformApp.update({
      where: { id: app_id },
      data: {
        ...(body.app_name !== undefined ? { app_name: body.app_name.trim() } : {}),
        ...(package_name !== undefined ? { package_name } : {}),
        ...(sha_key !== undefined ? { sha_key } : {}),
        ...(body.status !== undefined
          ? { status: body.status === 'disabled' ? PlatformAppStatus.disabled : PlatformAppStatus.active }
          : {}),
      },
      select: platformAppSelect,
    });

    await writeAdminAudit(tx, context, {
      action: 'platform_app.update',
      entity_type: 'platform_app',
      entity_id: updated.id,
      old_values: {
        app_name: existing.app_name,
        package_name: existing.package_name,
        sha_key: existing.sha_key,
        status: existing.status,
      },
      new_values: {
        app_name: updated.app_name,
        package_name: updated.package_name,
        sha_key: updated.sha_key,
        status: updated.status,
      },
    });

    return updated;
  });

  return serializePlatformApp(app);
};

const deletePlatformApp = async (app_id: string, context: AdminAuditContext) => {
  const existing = await findPlatformAppOrThrow(app_id);

  await prisma.$transaction(async (tx) => {
    await tx.platformApp.delete({ where: { id: app_id } });
    await writeAdminAudit(tx, context, {
      action: 'platform_app.delete',
      entity_type: 'platform_app',
      entity_id: app_id,
      old_values: {
        app_name: existing.app_name,
        package_name: existing.package_name,
        sha_key: existing.sha_key,
        status: existing.status,
      },
    });
  });
};

const PlatformAppService = {
  listPlatformApps,
  getPlatformApp,
  createPlatformApp,
  updatePlatformApp,
  deletePlatformApp,
};

export default PlatformAppService;
