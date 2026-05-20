-- Agents as a first-class entity + per-case/per-run/per-session metrics.
--
-- This migration consolidates eight in-progress migrations (011–018) from
-- the feat/agents-first-class branch into a single deploy step. The
-- individual files were authored separately during development to
-- aid review, but they ship together in one PR, so collapsing them avoids
-- a noisy `_migrations` history on first apply and sidesteps a numbering
-- collision with main's 012_drop_raw_payload_column.
--
-- Sections:
--   1. agent_transport_sessions: agent_id + agent_name columns
--   2. agents table + backfill + FK constraints
--   3. eval_runs lifecycle (status, last_activity_at, finished_at nullable)
--   4. eval_runs.name
--   5. eval_cases + eval_runs latency / counter columns
--   6. eval_cases + eval_runs token columns
--   7. eval_cases + eval_runs estimated_cost_usd
--   8. agent_transport_sessions.estimated_cost_usd
--
-- Every column add uses IF NOT EXISTS; every constraint add uses an
-- existence guard. The file is safe to re-run.

-- ─── 1. Promote agent_id + agent_name on sessions ─────────────────────────
--
-- Both columns are SDK-supplied (AudioStreamServer / AgentServer take
-- agent_id and agent_name kwargs) and reach obs via the OTLP session-
-- report log + `agent_id:<value>` / `agent_name:<value>` session tags.
-- The ingest path returns 400 if agent_id is missing.
--
-- DEPLOYMENT SAFETY: PostgreSQL rejects ADD COLUMN ... NOT NULL on a
-- non-empty table without a DEFAULT. Add nullable first, then
-- conditionally enforce NOT NULL only when no offending rows exist.

ALTER TABLE agent_transport_sessions
  ADD COLUMN IF NOT EXISTS agent_id   TEXT,
  ADD COLUMN IF NOT EXISTS agent_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_transport_sessions WHERE agent_id IS NULL
  ) THEN
    BEGIN
      ALTER TABLE agent_transport_sessions ALTER COLUMN agent_id SET NOT NULL;
    EXCEPTION WHEN others THEN
      -- Already NOT NULL on a re-run; ignore.
      NULL;
    END;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_ats_agent_id   ON agent_transport_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_ats_agent_name ON agent_transport_sessions (agent_name);

-- ─── 2. agents as a first-class entity ────────────────────────────────────
--
-- Identity model: agent_id is the natural primary key. account_id is just
-- a column on the agent row (most-recently-observed). Same agent_id
-- across two accounts merges into one row via last-writer-wins on
-- account_id and COALESCE-merge on agent_name. Every ingest path upserts
-- the agent before inserting its session/eval row; the FK enforces.

CREATE TABLE IF NOT EXISTS agents (
  agent_id    TEXT        PRIMARY KEY,
  account_id  TEXT,
  agent_name  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata    JSONB
);

CREATE INDEX IF NOT EXISTS idx_agents_account ON agents (account_id);
CREATE INDEX IF NOT EXISTS idx_agents_name    ON agents (agent_name);

-- Backfill from existing data. Last-writer-wins: take the most recent
-- agent_name + account_id observed. ON CONFLICT DO NOTHING because we
-- run two INSERT...SELECTs (sessions, then eval_runs).
INSERT INTO agents (agent_id, account_id, agent_name)
SELECT
  agent_id,
  (array_agg(account_id ORDER BY ended_at DESC NULLS LAST))[1] AS account_id,
  (array_agg(agent_name ORDER BY ended_at DESC NULLS LAST))[1] AS agent_name
FROM agent_transport_sessions
WHERE agent_id IS NOT NULL
GROUP BY agent_id
ON CONFLICT (agent_id) DO NOTHING;

INSERT INTO agents (agent_id, account_id)
SELECT
  agent_id,
  (array_agg(account_id ORDER BY started_at DESC NULLS LAST))[1] AS account_id
FROM eval_runs
WHERE agent_id IS NOT NULL
GROUP BY agent_id
ON CONFLICT (agent_id) DO NOTHING;

-- Single-column FKs. upsertAgent in src/agents/upsert.ts guarantees the
-- agents row exists before any child INSERT.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_transport_sessions_agent_fkey'
  ) THEN
    ALTER TABLE agent_transport_sessions
      ADD CONSTRAINT agent_transport_sessions_agent_fkey
      FOREIGN KEY (agent_id) REFERENCES agents (agent_id);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'eval_runs_agent_fkey'
  ) THEN
    ALTER TABLE eval_runs
      ADD CONSTRAINT eval_runs_agent_fkey
      FOREIGN KEY (agent_id) REFERENCES agents (agent_id);
  END IF;
END$$;

-- ─── 3. eval_runs lifecycle (status + activity tracking) ─────────────────
--
-- Plugin posts status='running' at pytest_sessionstart and the final
-- status at pytest_sessionfinish. Server stamps last_activity_at on
-- each write; the read overlay in src/evals/overlay.ts flips
-- status='running' rows to 'completed' after >1h of inactivity to
-- handle hard-kill cases (SIGKILL, OOM) where the terminal POST
-- never lands.

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'completed',
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

-- ─── 4. Optional human-readable run label ────────────────────────────────
--
-- Plugins set via --agent-observability-run-name / AGENT_OBSERVABILITY_RUN_NAME.

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS name TEXT;

-- ─── 5. Latency + counter columns ────────────────────────────────────────
--
-- Per-case and per-run latency metrics. Server computes these from the
-- events array the plugin already sends — no payload change. Columns are
-- NULL when no samples exist (text-only suites never emit TTFB; the UI
-- auto-hides TTFB cards in that case). Run-level percentiles are
-- computed over the full sample distribution across all cases (not
-- avg-of-case-medians), so p95 stays meaningful.

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

-- ─── 6. Token usage columns ──────────────────────────────────────────────
--
-- Computed server-side from the `llm_*_tokens` metric keys LiveKit emits
-- on assistant messages — plugin already sends events with these in
-- item.metrics. BIGINT (long-context runs can exceed INT range);
-- NOT NULL DEFAULT 0 so the running POST starts at 0 and the terminal
-- POST overwrites with real sums via EXCLUDED in ON CONFLICT.
--
-- cached_prompt_tokens is a SUBSET of prompt_tokens. Cache % is computed
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

-- ─── 7. Estimated cost on eval cases + runs ──────────────────────────────
--
-- Computed server-side from tokens (section 6) and model pricing
-- (src/evals/pricing.ts → models.dev with in-memory cache + static seed
-- fallback).
--
-- NULL  = "had priceable tokens but at least one model wasn't in the
--          pricing table" (mixed-model run — refuse to ship a partial sum)
-- 0     = "no tokens to price" (e.g. running-POST snapshot)
-- > 0   = computed sum
--
-- Distinguishing null vs 0 matters in the UI: null renders an em-dash,
-- 0 renders "$0.00".

ALTER TABLE eval_cases
  ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION;

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION;

-- ─── 8. Estimated cost on sessions ───────────────────────────────────────
--
-- Per-session cost computed in mergeSessionRawReport at OTLP-back-fill
-- time using the same `priceFor(provider, model)` path eval-runs use.
-- The atomic UPDATE that writes session_metrics.usage also writes this
-- column under the same WHERE clause so the two values can't drift on
-- duplicate OTLP delivery.

ALTER TABLE agent_transport_sessions
  ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION;
