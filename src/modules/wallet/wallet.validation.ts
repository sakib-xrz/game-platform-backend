import { z } from 'zod';

export const walletHistorySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const adminAdjustWalletSchema = z.object({
  body: z.object({
    user_id: z.string().trim().min(1).max(128),
    amount: z.string().regex(/^-?[1-9]\d*$/, 'amount must be a non-zero integer string'),
    reason: z.string().trim().min(3).max(250),
  }),
});

export type AdminAdjustWalletBody = z.infer<typeof adminAdjustWalletSchema>['body'];
