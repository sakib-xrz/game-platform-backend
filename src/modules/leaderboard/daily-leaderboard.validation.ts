import { z } from 'zod';

export const dailyLeaderboardQuerySchema = z.object({
  query: z.object({
    period: z.enum(['today', 'yesterday']).default('today'),
  }),
});

export type DailyLeaderboardQuery = z.infer<typeof dailyLeaderboardQuerySchema>['query'];
