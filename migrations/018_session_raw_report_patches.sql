-- Staging area for OTLP raw_report patches that arrive BEFORE the
-- recording multipart has created the session row. Previously these
-- patches ran UPDATEs that matched zero rows, silently dropping
-- usage/cost/events. Now they are parked here and drained (in arrival
-- order) once insertSession creates the row — mirroring how session_tags
-- are replayed via applyStoredSessionTags.
CREATE TABLE IF NOT EXISTS session_raw_report_patches (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  patch JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drain reads all rows for a session ordered by arrival.
CREATE INDEX IF NOT EXISTS idx_session_raw_report_patches_session
  ON session_raw_report_patches (session_id, id);
