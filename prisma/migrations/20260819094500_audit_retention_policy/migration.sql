-- Keep the audit trail append-only, while allowing a controlled retention job
-- to purge rows older than one year inside a transaction-local flag.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_retention_purge', true) = 'on'
     AND OLD.created_at < CURRENT_TIMESTAMP - INTERVAL '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit logs are append-only';
END;
$$ LANGUAGE plpgsql;
