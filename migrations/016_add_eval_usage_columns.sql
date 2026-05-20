-- Per-case and per-run token usage. Computed server-side from the
-- `llm_*_tokens` metric keys LiveKit emits on assistant messages — the
-- plugin already sends events with these in `item.metrics`, so no
-- payload change is needed.
--
-- All four columns are BIGINT (token counts can be large for long-
-- context runs) and NOT NULL DEFAULT 0 so the running POST (cases=[])
-- starts at 0; the terminal POST overwrites with real sums via
-- EXCLUDED in ON CONFLICT (same pattern as the latency columns from
-- migration 015).
--
-- cached_prompt_tokens is a subset of prompt_tokens (e.g., 800 of 1000
-- prompt tokens came from the provider's cache). Cache % is computed
-- at render time as cached / prompt.

ALTER TABLE eval_cases
  ADD COLUMN IF NOT EXISTS prompt_tokens        BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens         BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_prompt_tokens BIGINT NOT NULL DEFAULT 0;

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS prompt_tokens        BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens         BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_prompt_tokens BIGINT NOT NULL DEFAULT 0;
