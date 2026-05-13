-- Promote agents to a first-class entity (agent_id as the natural key).
--
-- Identity model: agent_id ALONE is the primary key. account_id is just a
-- column on the agent row (the most-recently-observed account that posted
-- for this agent). Same agent_id across two accounts merges into one row
-- via last-writer-wins on account_id and COALESCE-merge on agent_name.
-- This keeps the identity story simple ("agent_id is the agent") without
-- forcing a multi-tenant composite key that's hard to reason about.
--
-- Every ingest path (multipart session report, eval upload, OTLP session-
-- report log, OTLP agent_id/agent_name tag) upserts the agent row before
-- inserting its session/eval row. FK on sessions.agent_id / eval_runs.agent_id
-- guarantees the agent exists.
--
-- account_id on sessions/eval_runs stays nullable -- it's an event-level
-- tenant scope, distinct from the agent's "owner" account. No coercion
-- needed; the FK is single-column so NULL vs '' doesn't matter.

CREATE TABLE IF NOT EXISTS agents (
  agent_id    TEXT        PRIMARY KEY,
  account_id  TEXT,
  agent_name  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata    JSONB
);

CREATE INDEX IF NOT EXISTS idx_agents_account ON agents (account_id);
CREATE INDEX IF NOT EXISTS idx_agents_name    ON agents (agent_name);

-- Backfill agents from existing data. Last-writer-wins: take the most
-- recent agent_name + account_id observed across sessions; eval_runs
-- fill in any agent that exists only there.
INSERT INTO agents (agent_id, account_id, agent_name)
SELECT
  agent_id,
  (array_agg(account_id  ORDER BY ended_at DESC NULLS LAST))[1] AS account_id,
  (array_agg(agent_name  ORDER BY ended_at DESC NULLS LAST))[1] AS agent_name
FROM agent_transport_sessions
WHERE agent_id IS NOT NULL
GROUP BY agent_id
ON CONFLICT (agent_id) DO NOTHING;

INSERT INTO agents (agent_id, account_id)
SELECT
  agent_id,
  (array_agg(account_id ORDER BY started_at DESC NULLS LAST))[1] AS account_id
FROM eval_runs
WHERE agent_id IS NOT NULL
GROUP BY agent_id
ON CONFLICT (agent_id) DO NOTHING;

-- Single-column FK: child rows must reference an existing agent. The
-- upsert helper guarantees the row exists before the child INSERT.
ALTER TABLE agent_transport_sessions
  ADD CONSTRAINT agent_transport_sessions_agent_fkey
  FOREIGN KEY (agent_id) REFERENCES agents (agent_id);

ALTER TABLE eval_runs
  ADD CONSTRAINT eval_runs_agent_fkey
  FOREIGN KEY (agent_id) REFERENCES agents (agent_id);
