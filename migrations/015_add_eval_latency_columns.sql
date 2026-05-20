-- Per-case and per-run latency metrics. Server computes these from the
-- events array the plugin already sends, so no plugin payload change is
-- needed. Columns are NULL when no samples exist (text-only suites
-- never emit TTFB; the dashboard auto-hides TTFB cards in that case).
--
-- Run-level percentiles are computed over the full sample distribution
-- across all cases (not avg-of-case-medians), so p95 stays meaningful.
-- Counters at the run level are simple sums across cases — equivalent
-- under either "recompute from flat events" or "sum case counters"; we
-- recompute for consistency with the percentile path.

ALTER TABLE eval_cases
  ADD COLUMN IF NOT EXISTS ttft_p50_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttft_p95_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttft_avg_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttfb_p50_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttfb_p95_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttfb_avg_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS turn_count           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_call_count      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interruption_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agent_handoff_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ttft_sample_count    INTEGER NOT NULL DEFAULT 0;

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS ttft_p50_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttft_p95_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttft_avg_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttfb_p50_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttfb_p95_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS ttfb_avg_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS turn_count           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_call_count      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interruption_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agent_handoff_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ttft_sample_count    INTEGER NOT NULL DEFAULT 0;
