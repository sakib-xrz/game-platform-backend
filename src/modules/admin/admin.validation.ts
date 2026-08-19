import { z } from 'zod';

const email = z.string().trim().email().max(320).transform((value) => value.toLowerCase());
const password = z.string().min(12).max(128);
const role = z.enum(['super_admin', 'game_operator', 'finance_operator', 'support', 'auditor']);
const status = z.enum(['active', 'locked', 'disabled']);

export const loginSchema = z.object({ body: z.object({ email, password }) });
export const changePasswordSchema = z.object({ body: z.object({ current_password: password, new_password: password }) });
export const createAdminSchema = z.object({
  body: z.object({
    email,
    display_name: z.string().trim().min(1).max(120),
    role,
    password,
    force_password_change: z.boolean().optional(),
  }),
});
export const updateAdminSchema = z.object({
  params: z.object({ admin_id: z.string().trim().cuid() }),
  body: z.object({
    display_name: z.string().trim().min(1).max(120).optional(),
    role: role.optional(),
    status: status.optional(),
    force_password_change: z.boolean().optional(),
  }).refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
});
export const adminIdSchema = z.object({ params: z.object({ admin_id: z.string().trim().cuid() }) });
export const sessionIdSchema = z.object({ params: z.object({ session_id: z.string().trim().cuid() }) });
export const resetPasswordSchema = z.object({ params: z.object({ admin_id: z.string().trim().cuid() }), body: z.object({ password }) });
export const updatePolicySchema = z.object({ body: z.object({ wallet_adjustment_threshold: z.string().regex(/^\d+$/), approval_expiry_minutes: z.number().int().min(1).max(10080) }) });
export const approvalParamSchema = z.object({ params: z.object({ approval_id: z.string().trim().cuid() }) });
export const approvalDecisionSchema = z.object({ params: z.object({ approval_id: z.string().trim().cuid() }), body: z.object({ reason: z.string().trim().min(3).max(250).optional() }) });
export const approvalListSchema = z.object({ query: z.object({ page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20) }) });

export type LoginBody = z.infer<typeof loginSchema>['body'];
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>['body'];
export type CreateAdminBody = z.infer<typeof createAdminSchema>['body'];
export type UpdateAdminBody = z.infer<typeof updateAdminSchema>['body'];
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>['body'];
export type UpdatePolicyBody = z.infer<typeof updatePolicySchema>['body'];
export type ApprovalDecisionBody = z.infer<typeof approvalDecisionSchema>['body'];
