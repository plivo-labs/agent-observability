ALTER TABLE agent_transport_sessions
    ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ats_account_id ON agent_transport_sessions (account_id);
