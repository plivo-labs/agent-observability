-- Drop eval_runs.raw_payload (originally created by 008_create_eval_runs).
--
-- The column stored a verbatim re-serialization of the v0 payload — every
-- field of which already lands in named columns (run_id, account_id,
-- agent_id, framework, testing_framework, started_at, finished_at, the
-- pass/fail tallies) or in JSONB blobs that round-trip arbitrary content
-- (eval_runs.ci, eval_cases.{events, judgments, failure}). With no API,
-- UI, or query consumer reading raw_payload, the column was pure write
-- and storage overhead.
--
-- `IF EXISTS` so this is idempotent on dev databases where the column
-- was already dropped manually during development. On a fresh database,
-- 008 creates the column and this migration immediately drops it; the
-- net result is the same column-free shape that the application code
-- expects when it INSERTs into eval_runs.

ALTER TABLE eval_runs DROP COLUMN IF EXISTS raw_payload;
