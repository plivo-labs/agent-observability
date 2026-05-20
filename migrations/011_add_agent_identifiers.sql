-- Promote agent_id + agent_name to indexed columns on agent_transport_sessions.
--
-- Both are developer-supplied via the SDK (AudioStreamServer /
-- AgentServer take agent_id and agent_name kwargs) and reach obs on
-- the session-report OTLP log + `agent_id:<value>` / `agent_name:<value>`
-- session tags. The ingest path in src/index.ts validates agent_id is
-- present and returns 400 if not.
--
-- DEPLOYMENT SAFETY: PostgreSQL rejects ADD COLUMN ... NOT NULL on a
-- non-empty table without a DEFAULT. To stay safe across both fresh
-- installs and existing deployments that ingested sessions between
-- migrations 010 and 011, we add the column nullable first, then
-- conditionally enforce NOT NULL only when every row already has a
-- value (true on a fresh DB and on deployments where producers were
-- updated alongside this migration). Operators with old session rows
-- can backfill and then run `ALTER COLUMN ... SET NOT NULL` manually.
--
-- agent_id is the stable opaque identifier (UUID4); agent_name is the
-- human-readable label. The two-column design backs the
-- (agent_id, account_id) composite key used by the agents view.

ALTER TABLE agent_transport_sessions
  ADD COLUMN IF NOT EXISTS agent_id   TEXT,
  ADD COLUMN IF NOT EXISTS agent_name TEXT;

-- Apply NOT NULL only when no offending rows exist. On a fresh DB
-- (no rows yet) the constraint adds cleanly. On a deployment with
-- pre-existing sessions that pre-date this migration's producers,
-- this DO block is a no-op and the column stays nullable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_transport_sessions WHERE agent_id IS NULL
  ) THEN
    BEGIN
      ALTER TABLE agent_transport_sessions ALTER COLUMN agent_id SET NOT NULL;
    EXCEPTION WHEN others THEN
      -- Already NOT NULL on a re-run; ignore.
      NULL;
    END;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_ats_agent_id   ON agent_transport_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_ats_agent_name ON agent_transport_sessions (agent_name);
