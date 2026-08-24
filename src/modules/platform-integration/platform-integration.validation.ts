import { z } from 'zod';

const externalUserId = z.string().trim().min(1).max(128);
const email = z.string().trim().email().max(320);
const amount = z.string().trim().regex(/^[1-9]\d*$/, 'amount must be a positive integer string');
const clientRequestId = z.string().trim().min(1).max(128);
const photoUrl = z.string().trim().url().max(2048).optional().nullable();
const packageName = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i,
    'Package name must be a valid Android-style identifier (e.g. com.example.app)',
  );
const shaKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Fa-f0-9:]+$/, 'SHA key must contain only hex characters and optional colons');
const appName = z.string().trim().min(1).max(120);

/** App identity — must match an active Platform App record. */
export const appCredentialsSchema = z.object({
  app_name: appName,
  package_name: packageName,
  sha_key: shaKey,
});

export type AppCredentials = z.infer<typeof appCredentialsSchema>;

export const syncPlatformUserSchema = z.object({
  body: appCredentialsSchema.extend({
    external_user_id: externalUserId,
    email,
    name: z.string().trim().min(1).max(120),
    photo_url: photoUrl,
  }),
});

export const creditPlatformUserCoinsSchema = z.object({
  body: appCredentialsSchema.extend({
    external_user_id: externalUserId,
    amount,
    client_request_id: clientRequestId,
  }),
});

export const withdrawPlatformUserCoinsSchema = z.object({
  body: appCredentialsSchema.extend({
    external_user_id: externalUserId,
    amount,
    client_request_id: clientRequestId,
  }),
});

export const externalUserIdParamSchema = z.object({
  params: z.object({
    external_user_id: externalUserId,
  }),
  query: appCredentialsSchema,
});

export const launchPlatformUserSchema = z.object({
  query: appCredentialsSchema.extend({
    external_user_id: externalUserId,
    path: z.string().trim().max(200).optional(),
  }),
});

export type SyncPlatformUserBody = z.infer<typeof syncPlatformUserSchema>['body'];
export type CreditPlatformUserCoinsBody = z.infer<typeof creditPlatformUserCoinsSchema>['body'];
export type WithdrawPlatformUserCoinsBody = z.infer<typeof withdrawPlatformUserCoinsSchema>['body'];
export type LaunchPlatformUserQuery = z.infer<typeof launchPlatformUserSchema>['query'];
