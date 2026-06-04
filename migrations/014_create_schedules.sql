-- Scheduled evaluations: run a saved scenario on a cadence and alert when the
-- pass-rate slips. Truman-style recurring checks.

CREATE TABLE IF NOT EXISTS sim_schedules (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  scenario_id      TEXT NOT NULL,
  interval_minutes INT NOT NULL DEFAULT 1440,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  alert_pass_rate  INT,            -- alert if pass-rate (%) drops below this; null = no alert
  slack_webhook    TEXT,           -- optional Slack incoming-webhook URL
  last_run_at      TIMESTAMPTZ,
  last_pass_rate   INT,
  last_eval_run_id TEXT,
  next_run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sim_schedules_due_idx ON sim_schedules (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS sim_alerts (
  id           SERIAL PRIMARY KEY,
  schedule_id  TEXT NOT NULL,
  schedule_name TEXT,
  message      TEXT NOT NULL,
  pass_rate    INT,
  eval_run_id  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
