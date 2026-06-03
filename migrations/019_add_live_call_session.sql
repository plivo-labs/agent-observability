-- Link a real Live call to the Monitor session created from its LiveKit metrics.
-- When a Truman call reconciles, AO builds a Monitor session (agent_transport_sessions,
-- transport='phone') from the caller agent's per-turn metrics and stores its id here,
-- so the Live UI can deep-link to the session's Performance tab.
ALTER TABLE sim_live_calls ADD COLUMN IF NOT EXISTS session_id UUID;
