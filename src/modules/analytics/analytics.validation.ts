import { z } from 'zod';

const dateQuery = z.coerce.date().optional();

export const analyticsOverviewSchema = z.object({
  query: z.object({
    from: dateQuery,
    to: dateQuery,
  }),
});

const boolQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  });

export const analyticsUsersSchema = z.object({
  query: z.object({
    search: z.string().trim().max(200).optional().default(''),
    platform_app_id: z.string().trim().cuid().optional(),
    from: dateQuery,
    to: dateQuery,
    /** When true (default), only humans who placed bets in the window. */
    players_only: boolQuery.default(true),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .refine((value) => [10, 20, 50, 100].includes(value), {
        message: 'limit must be 10, 20, 50, or 100',
      })
      .default(20),
    sort: z
      .enum(['lost', 'won', 'coins_added', 'net_result', 'balance', 'company_profit'])
      .default('company_profit'),
    sort_dir: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const analyticsUserDetailSchema = z.object({
  params: z.object({
    user_id: z.string().trim().cuid(),
  }),
  query: z.object({
    from: dateQuery,
    to: dateQuery,
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .refine((value) => [10, 20, 50, 100].includes(value), {
        message: 'limit must be 10, 20, 50, or 100',
      })
      .default(50),
  }),
});

export type AnalyticsOverviewQuery = z.infer<typeof analyticsOverviewSchema>['query'];
export type AnalyticsUsersQuery = z.infer<typeof analyticsUsersSchema>['query'];
export type AnalyticsUserDetailQuery = z.infer<typeof analyticsUserDetailSchema>['query'];
