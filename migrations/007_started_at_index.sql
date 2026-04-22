CREATE INDEX IF NOT EXISTS idx_ats_started_at ON agent_transport_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ats_account_id ON agent_transport_sessions (account_id);
