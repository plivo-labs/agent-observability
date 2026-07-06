-- Ingest-based evals: store the agent/flow authoring config a client attaches at
-- call end, and the verdicts the background eval sweeper produces from it.
--
-- session_agent_config is the generic "what was the agent configured to do"
-- record (per-node instructions, intents, variable rules, goals, opaque node
-- refs). Its presence is the eval opt-in: the sweeper only judges sessions
-- that carry one.
CREATE TABLE IF NOT EXISTS session_agent_config (
  session_id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'livekit_otlp',
  observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per evaluated session. The row doubles as the work claim: the
-- sweeper claims a session by inserting (status='running'); losers of the
-- race hit the PK conflict and move on. Stale 'running' rows (worker died
-- mid-judge) are re-claimed after a timeout. 'error' is terminal for
-- deterministic failures (e.g. provider content policy) so one bad session
-- can never burn retries or block the queue.
CREATE TABLE IF NOT EXISTS session_eval_verdicts (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'error')),
  verdicts JSONB,
  error TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_eval_verdicts_status
  ON session_eval_verdicts (status, claimed_at);
