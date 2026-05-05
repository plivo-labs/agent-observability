ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

ALTER TABLE eval_runs
  ALTER COLUMN finished_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eval_runs_status_started ON eval_runs (status, started_at DESC);
