-- Composite index for efficient filtered + sorted pagination:
-- GET /api/sessions?account_id=X uses WHERE account_id = X ORDER BY ended_at DESC LIMIT/OFFSET
CREATE INDEX IF NOT EXISTS idx_ats_account_id_ended_at
    ON agent_transport_sessions (account_id, ended_at DESC);
