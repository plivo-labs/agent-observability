-- 021: idempotent ingest + tag lookup performance.
--
-- DEPLOY NOTE: the unique-index build below takes a SHARE lock on
-- agent_transport_sessions (the busiest table) for its duration — ingest
-- writes block until it commits. On a large table run this off-peak, or
-- pre-create the index CONCURRENTLY outside the transactional migration
-- runner and let the IF NOT EXISTS here no-op.
--
-- (1) agent_transport_sessions.session_id gains a UNIQUE index so at-least-once
--     recording uploads (client retries after a timeout the server actually
--     committed) can't create duplicate sessions. Pre-existing duplicates are
--     collapsed to the earliest row first (children in other tables key on
--     session_id, not the row id, so dropping later duplicates is safe).
-- (2) session_tags gets a (name) index: the by-tag lookup (e.g.
--     `flow_run_uuid:<uuid>` from external run-id consumers) is a hot read
--     path and previously sequential-scanned the table.

DELETE FROM agent_transport_sessions a
  USING agent_transport_sessions b
  WHERE a.session_id = b.session_id
    AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_transport_sessions_session_id
  ON agent_transport_sessions (session_id);

CREATE INDEX IF NOT EXISTS idx_session_tags_name
  ON session_tags (name, created_at DESC);

-- (3) The eval sweeper's fresh-claim query orders session_agent_config by
--     created_at (oldest unjudged first) on every claim attempt — without
--     this index that is a seq-scan + sort over the whole table, repeated
--     up to MAX_PER_SWEEP times per tick, degrading as the table grows.
CREATE INDEX IF NOT EXISTS idx_session_agent_config_created_at
  ON session_agent_config (created_at);
