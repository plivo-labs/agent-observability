-- 022: idempotent ingest + tag lookup performance.
--
-- DEPLOY NOTE: the unique-index build below takes a SHARE lock on
-- agent_transport_sessions (the busiest table) for its duration — ingest
-- writes block until it commits. On a large table run this off-peak, or
-- pre-create the index CONCURRENTLY outside the transactional migration
-- runner and let the IF NOT EXISTS here no-op. The pre-created index MUST use
-- the SAME name as below (uq_…) — IF NOT EXISTS matches by name, so a
-- differently-named pre-build would not be seen and the migration would still
-- run the in-transaction full-lock build (and leave a duplicate index). And it
-- MUST be run AFTER the de-dupe DELETE (lines below), otherwise CONCURRENTLY
-- leaves an INVALID index on any pre-existing session_id duplicates:
--   -- 1. remove pre-existing dupes first (same as the DELETE below)
--   DELETE FROM agent_transport_sessions a USING agent_transport_sessions b
--     WHERE a.session_id = b.session_id AND a.id > b.id;
--   -- 2. then build the index off-transaction, matching name:
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_agent_transport_sessions_session_id
--     ON agent_transport_sessions (session_id);
-- The lock_timeout below makes the migration FAIL FAST (and roll back) if it
-- cannot take its locks within 10s — a failed migration you retry off-peak
-- beats one that silently blocks live ingest while it waits.
SET LOCAL lock_timeout = '10s';
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
