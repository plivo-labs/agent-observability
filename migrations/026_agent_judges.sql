-- Agent ↔ custom-judge mapping: which custom judges score which agent's
-- sessions. Default judges run for everyone and need no rows here. Lives in
-- AO (not the flow config) so the builder writes it straight to the judges
-- API and the sweeper resolves it with a local join on the session's agent_id.
-- Deleting a judge cascades its mappings; ao_agents has no FK here because
-- agent rows can arrive after a mapping is written on a fresh account.
CREATE TABLE IF NOT EXISTS ao_agent_judges (
  agent_id TEXT NOT NULL,
  judge_id UUID NOT NULL REFERENCES ao_judges (id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, judge_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_judges_judge ON ao_agent_judges (judge_id);
