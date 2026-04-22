CREATE TABLE IF NOT EXISTS eval_runs (
    run_id            UUID PRIMARY KEY,
    account_id        TEXT,
    agent_id          TEXT,
    framework         TEXT NOT NULL,
    framework_version TEXT,
    sdk               TEXT,
    sdk_version       TEXT,
    started_at        TIMESTAMPTZ NOT NULL,
    finished_at       TIMESTAMPTZ NOT NULL,
    duration_ms       BIGINT,
    total             INTEGER NOT NULL DEFAULT 0,
    passed            INTEGER NOT NULL DEFAULT 0,
    failed            INTEGER NOT NULL DEFAULT 0,
    errored           INTEGER NOT NULL DEFAULT 0,
    skipped           INTEGER NOT NULL DEFAULT 0,
    ci                JSONB,
    raw_payload       JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_account_started ON eval_runs (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_agent_started   ON eval_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_started         ON eval_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS eval_cases (
    case_id      UUID PRIMARY KEY,
    run_id       UUID NOT NULL REFERENCES eval_runs(run_id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    file         TEXT,
    status       TEXT NOT NULL,
    duration_ms  BIGINT,
    user_input   TEXT,
    events       JSONB NOT NULL DEFAULT '[]'::jsonb,
    judgments    JSONB NOT NULL DEFAULT '[]'::jsonb,
    failure      JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_run_id ON eval_cases (run_id);
CREATE INDEX IF NOT EXISTS idx_eval_cases_status ON eval_cases (status);
