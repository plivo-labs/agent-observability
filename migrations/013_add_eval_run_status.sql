-- Live run lifecycle: status, server-tracked activity, nullable finished_at.
--
-- Flow:
--   - Plugin POSTs status='running' at pytest_sessionstart (empty cases).
--   - Plugin POSTs status from exitcode at pytest_sessionfinish (with cases).
--   - Server stamps last_activity_at = NOW() on each write.
--
-- Read overlay (in JS, see src/evals/overlay.ts):
--   - status='running' AND last_activity_at older than 1h -> 'completed'.
--   - Covers the rare hard-kill (SIGKILL, OOM, machine death) case where
--     no pytest hook fires and the terminal POST never lands. Graceful
--     failures (Ctrl+C, internal error, test failures) are already
--     handled by sessionfinish, which always runs.

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

ALTER TABLE eval_runs
  DROP CONSTRAINT IF EXISTS eval_runs_status_check;

ALTER TABLE eval_runs
  ADD CONSTRAINT eval_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'));

-- Running runs don't have a finish time until the plugin finalizes them.
ALTER TABLE eval_runs ALTER COLUMN finished_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eval_runs_status_started
  ON eval_runs (status, started_at DESC);
