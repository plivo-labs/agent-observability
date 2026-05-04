ALTER TABLE eval_cases
    ADD COLUMN IF NOT EXISTS ttft_p50_ms          FLOAT,
    ADD COLUMN IF NOT EXISTS ttft_p95_ms          FLOAT,
    ADD COLUMN IF NOT EXISTS ttft_avg_ms          FLOAT,
    ADD COLUMN IF NOT EXISTS ttfb_p50_ms          FLOAT,
    ADD COLUMN IF NOT EXISTS ttfb_p95_ms          FLOAT,
    ADD COLUMN IF NOT EXISTS ttfb_avg_ms          FLOAT,
    ADD COLUMN IF NOT EXISTS turn_count           INT,
    ADD COLUMN IF NOT EXISTS tool_call_count      INT,
    ADD COLUMN IF NOT EXISTS interruption_count   INT,
    ADD COLUMN IF NOT EXISTS agent_handoff_count  INT,
    ADD COLUMN IF NOT EXISTS ttft_sample_count    INT;

ALTER TABLE eval_runs
    ADD COLUMN IF NOT EXISTS ttft_p50_ms FLOAT,
    ADD COLUMN IF NOT EXISTS ttft_p95_ms FLOAT,
    ADD COLUMN IF NOT EXISTS ttft_avg_ms FLOAT,
    ADD COLUMN IF NOT EXISTS ttfb_p50_ms FLOAT,
    ADD COLUMN IF NOT EXISTS ttfb_p95_ms FLOAT,
    ADD COLUMN IF NOT EXISTS ttfb_avg_ms FLOAT;
