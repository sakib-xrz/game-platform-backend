import { z } from 'zod';

const positiveIntegerString = z
  .string()
  .regex(/^[1-9]\d*$/, 'Must be a positive integer string');

export const placeBetSchema = z.object({
  body: z.object({
    round_id: z.string().trim().cuid(),
    option_id: z.string().trim().cuid(),
    amount: positiveIntegerString,
    client_request_id: z.string().trim().min(12).max(128),
  }),
});

export const greedyHistorySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const greedyClassicRoundParamSchema = z.object({
  params: z.object({ round_id: z.string().trim().cuid() }),
});

export type PlaceBetBody = z.infer<typeof placeBetSchema>['body'];
