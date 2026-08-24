import { z } from 'zod';

export const adminPlatformUserSearchSchema = z.object({
  query: z.object({
    search: z.string().trim().max(128).optional().default(''),
    platform_app_id: z.string().trim().cuid().optional(),
    status: z.enum(['active', 'disabled']).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(20),
  }),
});

export const adminPlatformUserIdSchema = z.object({
  params: z.object({ user_id: z.string().trim().cuid() }),
});

export const adminPlatformUserLedgerSchema = z.object({
  params: z.object({ user_id: z.string().trim().cuid() }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
});

export type AdminPlatformUserSearchQuery = z.infer<typeof adminPlatformUserSearchSchema>['query'];
export type AdminPlatformUserLedgerQuery = z.infer<typeof adminPlatformUserLedgerSchema>['query'];
