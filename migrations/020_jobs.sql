-- Generic Postgres-backed job queue (Stage 0.4).
--
-- Generalizes the alert-delivery pattern (FOR UPDATE SKIP LOCKED + lease +
-- backoff, see migration 017 / src/alerts) so Stage 1 eval runs and Stage 2
-- simulations can be enqueued and processed by the same worker loop. No Redis,
-- no SQS — survives restarts because all state is here (the aiassist
-- orphaned-run bug class). A claimed job's `next_attempt_at` is pushed forward
-- by a lease; if the worker crashes mid-job the row simply becomes due again.

CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,                       -- handler key, e.g. 'eval.run'
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'done', 'dead')),
  idempotency_key TEXT,                                -- optional; UNIQUE when present
  attempts        INTEGER NOT NULL DEFAULT 0,          -- incremented at claim time
  max_attempts    INTEGER NOT NULL DEFAULT 6,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- also the claim-lease anchor
  last_error      TEXT,
  locked_at       TIMESTAMPTZ,                         -- when the current lease was taken
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Due-work scan (mirrors idx_alert_firings_due).
CREATE INDEX IF NOT EXISTS idx_jobs_due
  ON jobs (next_attempt_at) WHERE status = 'pending';

-- Idempotent enqueue: a redelivered webhook carrying the same key inserts once.
-- Partial so multiple NULL keys (jobs without an idempotency key) are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key
  ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
