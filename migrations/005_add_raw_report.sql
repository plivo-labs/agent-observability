ALTER TABLE agent_transport_sessions
  ADD COLUMN IF NOT EXISTS raw_report JSONB;
