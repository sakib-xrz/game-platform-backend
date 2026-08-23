import { z } from 'zod';

const externalUserId = z.string().trim().min(1).max(128);
const email = z.string().trim().email().max(320);
const amount = z.string().trim().regex(/^[1-9]\d*$/, 'amount must be a positive integer string');
const clientRequestId = z.string().trim().min(1).max(128);
const photoUrl = z.string().trim().url().max(2048).optional().nullable();

export const syncPlatformUserSchema = z.object({
  body: z.object({
    external_user_id: externalUserId,
    email,
    name: z.string().trim().min(1).max(120),
    photo_url: photoUrl,
  }),
});

export const creditPlatformUserCoinsSchema = z.object({
  body: z.object({
    external_user_id: externalUserId,
    amount,
    client_request_id: clientRequestId,
  }),
});

export const withdrawPlatformUserCoinsSchema = z.object({
  body: z.object({
    external_user_id: externalUserId,
    amount,
    client_request_id: clientRequestId,
  }),
});

export const externalUserIdParamSchema = z.object({
  params: z.object({
    external_user_id: externalUserId,
  }),
});

export type SyncPlatformUserBody = z.infer<typeof syncPlatformUserSchema>['body'];
export type CreditPlatformUserCoinsBody = z.infer<typeof creditPlatformUserCoinsSchema>['body'];
export type WithdrawPlatformUserCoinsBody = z.infer<typeof withdrawPlatformUserCoinsSchema>['body'];
