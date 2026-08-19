import { z } from 'zod';
import { AdminRole, TeenPattiRoundStatus } from '@/generated/prisma/client';
import { createTeenPattiConfigSchema } from './game-admin.validation';

const positiveIntegerString = z.string().regex(/^[1-9]\d*$/);

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const cuidParam = z.object({ round_id: z.string().trim().cuid() });

export const configIdParamSchema = z.object({
  params: z.object({ config_id: z.string().trim().cuid() }),
});

export const roundListSchema = z.object({
  query: paginationSchema.extend({
    status: z.nativeEnum(TeenPattiRoundStatus).optional(),
    round_number: positiveIntegerString.optional(),
    config_version: z.coerce.number().int().positive().optional(),
    winner: z.string().trim().min(1).max(50).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});

export const roundParamSchema = z.object({ params: cuidParam });

export const roundBetsSchema = z.object({
  params: cuidParam,
  query: paginationSchema.extend({ user_id: z.string().trim().min(1).max(128).optional(), option_id: z.string().trim().cuid().optional() }),
});

export const userParamSchema = z.object({
  params: z.object({ user_id: z.string().trim().min(1).max(128) }),
});

export const metricsSchema = z.object({
  query: z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});

export const auditLogSchema = z.object({
  query: paginationSchema.extend({
    action: z.string().trim().min(1).max(120).optional(),
    entity_type: z.string().trim().min(1).max(120).optional(),
    actor_id: z.string().trim().min(1).max(128).optional(),
    actor_role: z.nativeEnum(AdminRole).optional(),
    outcome: z.string().trim().min(1).max(40).optional(),
    request_id: z.string().trim().min(1).max(128).optional(),
    approval_request_id: z.string().trim().cuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});

export const configBodySchema = createTeenPattiConfigSchema;
export const configUpdateSchema = z.object({
  params: z.object({ config_id: z.string().trim().cuid() }),
  body: createTeenPattiConfigSchema.shape.body,
});


export const availabilitySchema = z.object({
  body: z.object({
    status: z.enum(['active', 'paused', 'maintenance', 'disabled']),
  }),
});

export const alertParamSchema = z.object({ params: z.object({ alert_id: z.string().trim().cuid() }) });
export const alertListSchema = z.object({ query: z.object({ status: z.enum(['open', 'acknowledged', 'resolved']).optional(), page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20) }) });

export const assetPresignSchema = z.object({ body: z.object({ content_type: z.enum(['image/png', 'image/jpeg', 'image/webp']), byte_size: z.number().int().positive().max(2 * 1024 * 1024), checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/i) }) });
export const assetIdParamSchema = z.object({ params: z.object({ asset_id: z.string().trim().cuid() }) });

export type OpsRoundListQuery = z.infer<typeof roundListSchema>['query'];
export type OpsRoundBetsQuery = z.infer<typeof roundBetsSchema>['query'];
export type OpsMetricsQuery = z.infer<typeof metricsSchema>['query'];
export type OpsAuditLogQuery = z.infer<typeof auditLogSchema>['query'];
