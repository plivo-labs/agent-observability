CREATE TABLE IF NOT EXISTS session_tags (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata JSONB,
  source TEXT NOT NULL DEFAULT 'livekit_otlp',
  observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, name, source)
);

CREATE INDEX IF NOT EXISTS session_tags_session_id_idx
  ON session_tags (session_id);

CREATE TABLE IF NOT EXISTS session_external_evals (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  judge_name TEXT NOT NULL,
  tag TEXT,
  verdict TEXT,
  reasoning TEXT,
  instructions TEXT,
  observed_at TIMESTAMPTZ,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_external_evals_session_id_idx
  ON session_external_evals (session_id);

CREATE TABLE IF NOT EXISTS session_outcomes (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  observed_at TIMESTAMPTZ,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, source)
);

CREATE INDEX IF NOT EXISTS session_outcomes_session_id_idx
  ON session_outcomes (session_id);
