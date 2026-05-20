-- Optional human-readable label per run. Plugins set via
-- `--agent-observability-run-name` CLI flag or AGENT_OBSERVABILITY_RUN_NAME
-- env var. NULL when unset; legacy rows have no name.

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS name TEXT;
