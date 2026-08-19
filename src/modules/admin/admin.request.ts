import type { Request } from 'express';
import type { AdminAuditContext } from './admin.services';

export const requestAuditContext = (req: Request): AdminAuditContext => ({
  admin_user_id: req.admin?.id,
  actor_role: req.admin?.role,
  request_id: req.request_id,
  ip_address: req.ip,
  user_agent: req.get('user-agent')?.slice(0, 512),
  idempotency_key: req.header('idempotency-key')?.trim(),
});
