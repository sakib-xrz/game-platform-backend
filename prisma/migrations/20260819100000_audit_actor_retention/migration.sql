-- Preserve actor attribution for the append-only audit trail. Admin accounts
-- are disabled/recovered rather than deleted while their audit rows exist.
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_admin_user_id_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
