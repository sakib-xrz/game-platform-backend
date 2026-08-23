import { z } from 'zod';

const packageName = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'Package name must be a valid Android-style identifier (e.g. com.example.app)',
  );

const shaKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Fa-f0-9:]+$/, 'SHA key must contain only hex characters and optional colons');

const appStatus = z.enum(['active', 'disabled']);

export const createPlatformAppSchema = z.object({
  body: z.object({
    app_name: z.string().trim().min(1).max(120),
    package_name: packageName,
    sha_key: shaKey,
    status: appStatus.optional(),
  }),
});

export const updatePlatformAppSchema = z.object({
  params: z.object({ app_id: z.string().trim().cuid() }),
  body: z.object({
    app_name: z.string().trim().min(1).max(120).optional(),
    package_name: packageName.optional(),
    sha_key: shaKey.optional(),
    status: appStatus.optional(),
  }).refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
});

export const platformAppIdSchema = z.object({
  params: z.object({ app_id: z.string().trim().cuid() }),
});

export type CreatePlatformAppBody = z.infer<typeof createPlatformAppSchema>['body'];
export type UpdatePlatformAppBody = z.infer<typeof updatePlatformAppSchema>['body'];

export const normalizeShaKey = (value: string): string =>
  value.replace(/:/g, '').toUpperCase();

export const normalizePackageName = (value: string): string => value.trim().toLowerCase();
