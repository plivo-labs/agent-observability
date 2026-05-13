-- Promote agent_id + agent_name to indexed columns on agent_transport_sessions.
--
-- Both are developer-supplied via the SDK (AudioStreamServer /
-- AgentServer take agent_id and agent_name kwargs) and reach obs on
-- the session-report OTLP log + `agent_id:<value>` / `agent_name:<value>`
-- session tags. The ingest path in src/index.ts validates agent_id is
-- present and returns 400 if not, so the column ships NOT NULL from
-- day one — this PR also contains the matching SDK changes, so there
-- is no rollout window where producers might still skip the field
-- and no historical rows to backfill.
--
-- agent_id is the stable opaque identifier (UUID4); agent_name is the
-- human-readable label. The two-column design backs the
-- (agent_id, account_id) composite key used by the agents view.

ALTER TABLE agent_transport_sessions
  ADD COLUMN IF NOT EXISTS agent_id   TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS agent_name TEXT;

CREATE INDEX IF NOT EXISTS idx_ats_agent_id   ON agent_transport_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_ats_agent_name ON agent_transport_sessions (agent_name);
