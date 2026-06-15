-- Make session_id unique on agent_transport_sessions.
--
-- Why: the recordings ingest is at-least-once — the SDK retries a failed
-- upload, redelivering a byte-identical full recording. Without a unique
-- constraint, insertSession's plain INSERT created a duplicate row each time.
-- insertSession now upserts ON CONFLICT (session_id) DO NOTHING, which needs
-- this constraint. It is also the unique target the eval_runs.session_id FK
-- depends on (migration 021).
--
-- The migration runner wraps everything in one advisory-locked transaction and
-- aborts boot on any error, so we must dedup pre-existing duplicates BEFORE
-- adding the constraint. Keep the earliest row (lowest serial id) per
-- session_id — it is the one OTLP patches have been enriching.

DELETE FROM agent_transport_sessions a
USING agent_transport_sessions b
WHERE a.session_id = b.session_id
  AND a.id > b.id;

-- ADD CONSTRAINT has no IF NOT EXISTS; guard so the file is safe to re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_transport_sessions_session_id_key'
  ) THEN
    ALTER TABLE agent_transport_sessions
      ADD CONSTRAINT agent_transport_sessions_session_id_key UNIQUE (session_id);
  END IF;
END$$;

-- The old non-unique lookup index (migration 001) is now redundant: the unique
-- constraint's index serves the same session_id lookups.
DROP INDEX IF EXISTS idx_ats_session_id;
