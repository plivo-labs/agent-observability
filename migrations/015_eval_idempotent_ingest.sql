CREATE INDEX IF NOT EXISTS idx_eval_runs_running_heartbeat
  ON eval_runs (last_heartbeat_at)
  WHERE status = 'running';
