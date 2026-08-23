-- Allow controlled admin edits on published Greedy configs (timing, limits, options, chips).
-- review_pending and retired configs stay immutable at the database layer.

CREATE OR REPLACE FUNCTION protect_greedy_config_lifecycle() RETURNS trigger AS $$
BEGIN
  IF OLD.game_id IS DISTINCT FROM NEW.game_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'greedy configuration identity is immutable';
  END IF;
  IF OLD.status NOT IN ('draft', 'published') AND ROW(OLD.betting_duration_ms, OLD.lock_duration_ms,
       OLD.drawing_duration_ms, OLD.result_duration_ms, OLD.min_bet,
       OLD.max_single_bet, OLD.max_round_bet, OLD.notes)
     IS DISTINCT FROM ROW(NEW.betting_duration_ms, NEW.lock_duration_ms,
       NEW.drawing_duration_ms, NEW.result_duration_ms, NEW.min_bet,
       NEW.max_single_bet, NEW.max_round_bet, NEW.notes) THEN
    RAISE EXCEPTION 'reviewed and historical greedy configurations are immutable';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'review_pending') OR
    (OLD.status = 'review_pending' AND NEW.status = 'published') OR
    (OLD.status = 'published' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid greedy configuration status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_greedy_config_child() RETURNS trigger AS $$
DECLARE
  config_id TEXT;
  config_status config_version_status;
BEGIN
  config_id := COALESCE(NEW.config_version_id, OLD.config_version_id);
  SELECT status INTO config_status FROM greedy_config_versions WHERE id = config_id;
  IF config_status NOT IN ('draft'::config_version_status, 'published'::config_version_status) THEN
    RAISE EXCEPTION 'options and chips of reviewed configurations are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
