-- Real Live calling via Truman. AO orchestrates Truman's API: it provisions
-- Truman entities from the AO Library selections, creates a Truman suite (one
-- run per persona), then polls the runs and ingests the real transcript +
-- Truman's verdict. These tables track that orchestration.

-- Entity dedup map: AO Library entity (or inline content) → Truman id, so we
-- don't re-create a Truman agent/persona/rubric/scenario on every call. The
-- fingerprint is a content hash; when the AO content changes the fingerprint
-- changes and we provision a fresh Truman entity.
CREATE TABLE IF NOT EXISTS sim_truman_map (
  ao_kind     TEXT NOT NULL,            -- 'agent' | 'persona' | 'rubric' | 'scenario'
  ao_key      TEXT NOT NULL,            -- AO Library id, or a content hash for inline items
  fingerprint TEXT NOT NULL,            -- hash of the provisioned content
  truman_id   UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ao_kind, ao_key, fingerprint)
);

-- One row per Live suite (a batch of one call per persona).
CREATE TABLE IF NOT EXISTS sim_live_suites (
  id              UUID PRIMARY KEY,
  agent_name      TEXT NOT NULL,
  prompt          TEXT,
  phone_number    TEXT,
  truman_suite_id UUID,
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  eval_run_id     UUID,                            -- set once the suite finishes + persists
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per call in a suite (one per persona), mirrored from the Truman run.
CREATE TABLE IF NOT EXISTS sim_live_calls (
  id            UUID PRIMARY KEY,
  suite_id      UUID NOT NULL REFERENCES sim_live_suites(id) ON DELETE CASCADE,
  call_index    INT NOT NULL DEFAULT 0,
  persona_name  TEXT NOT NULL,
  persona_type  TEXT NOT NULL DEFAULT 'baseline',
  avatar        TEXT NOT NULL DEFAULT '#6366f1',
  opener        TEXT,
  truman_run_id UUID,
  -- lifecycle mirrored from Truman: queued|dialing|live|recording|evaluating|done|failed
  status        TEXT NOT NULL DEFAULT 'queued',
  verdict       TEXT,                              -- 'pass' | 'fail' (set on done)
  judge         JSONB,                             -- { criteria, overall, notes }
  transcript    JSONB,                             -- Turn[] (parsed from Truman transcript_text)
  cost          JSONB,                             -- { llm_tokens, tts_chars, stt_seconds, call_seconds, cents, raw }
  duration_s    INT NOT NULL DEFAULT 0,
  recording_url TEXT,                              -- AO-proxied audio path
  error         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_live_calls_suite ON sim_live_calls(suite_id);
CREATE INDEX IF NOT EXISTS idx_sim_live_suites_status ON sim_live_suites(status);
