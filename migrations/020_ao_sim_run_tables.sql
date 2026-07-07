-- AO Simulation Engine — run-result tables + scenario-table rename (aodb-write.md §3).
--
-- Three generic tables, all opaque to AO:
--   ao_sim_scenario      — the generated scenario library (renamed from 019's
--                          ao_simulation_scenarios; account_id → tenant_id).
--   ao_sim_run           — one row per run; id = the client-supplied run uuid
--                          (the orchestrator service mints it and sends it on SQS).
--   ao_sim_run_scenario  — one row per scenario execution; id = the per-conversation
--                          uuid AO mints (the value the orchestrator service knows as its
--                          per-conversation run uuid).
--
-- Identity pass-through: `agent_id` / `tenant_id` are opaque TEXT the caller supplies
-- (NO FK anywhere — AO never reads another service's tables). `sim_run_id` is a soft
-- ref (no hard FK) so any worker can insert a scenario row regardless of header state.
--
-- Deployment: OSS applies this via AO's migrator (AUTO_MIGRATE=on, its own DB). The
-- managed deployment hand-applies byte-equivalent DDL to the shared core DB (dev via
-- pgAdmin, prod via a goose migration) and runs AO with AUTO_MIGRATE=off — AO is
-- DML-only there, and src/db-probe.ts fails fast at boot if these tables are absent.
--
-- Every statement is guarded (IF NOT EXISTS / DO-blocks) — safe to re-run, and safe
-- when the tables were pre-created out-of-band (Plivo-style) before this file runs.

-- ─── 1. Rename 019's scenario table to the generic names ───────────────────────
-- Only when the old table exists and the new one doesn't (fresh OSS installs run
-- 019 → 020 in sequence; pre-created-core-DB installs never run either).

DO $$
BEGIN
  IF to_regclass('ao_simulation_scenarios') IS NOT NULL
     AND to_regclass('ao_sim_scenario') IS NULL THEN
    ALTER TABLE ao_simulation_scenarios RENAME TO ao_sim_scenario;
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('ao_sim_scenario') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ao_sim_scenario' AND column_name = 'account_id') THEN
    ALTER TABLE ao_sim_scenario RENAME COLUMN account_id TO tenant_id;
  END IF;
END$$;

-- Recreate under fresh-install path too (pre-created core-DB or a DB that never ran 019
-- under the old name). Column set matches 019 post-rename exactly.
CREATE TABLE IF NOT EXISTS ao_sim_scenario (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT,
  agent_id        TEXT,              -- opaque caller-supplied agent identifier; NO FK
  name            TEXT NOT NULL,
  scenario        JSONB NOT NULL,    -- full scenario dict (post validate_and_fix)
  tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  source          TEXT NOT NULL DEFAULT 'generated',  -- generated | manual | imported
  coverage_key    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_sim_scenario_source_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_simulation_scenarios_source_check') THEN
    ALTER TABLE ao_sim_scenario ADD CONSTRAINT ao_sim_scenario_source_check
      CHECK (source IN ('generated', 'manual', 'imported'));
  END IF;
END$$;

-- Soft delete: reads filter is_deleted = FALSE; the orchestrator-service side soft-deletes so
-- historical run exports keep scenario names. AO's own bulk-delete API stays a hard DELETE.
ALTER TABLE ao_sim_scenario ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- Fresh names for the 019 indexes (old ones ride along harmlessly if present).
CREATE INDEX IF NOT EXISTS idx_ao_sim_scenario_tenant_created
  ON ao_sim_scenario (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ao_sim_scenario_agent_created
  ON ao_sim_scenario (agent_id, created_at DESC) WHERE is_deleted = FALSE;

-- ─── 2. ao_sim_run — one row per run (header + rollup counters) ────────────────
-- id has NO default: it is always the client-supplied run uuid from the SQS message,
-- upserted with ON CONFLICT DO NOTHING so any worker can create the header first.

CREATE TABLE IF NOT EXISTS ao_sim_run (
  id                UUID PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  agent_id          TEXT NOT NULL,     -- opaque, NO FK
  name              TEXT,
  status            TEXT NOT NULL DEFAULT 'running',
  scenario_count    INTEGER NOT NULL DEFAULT 0,
  completed_count   INTEGER NOT NULL DEFAULT 0,
  scenarios_passed  INTEGER NOT NULL DEFAULT 0,
  scenarios_failed  INTEGER NOT NULL DEFAULT 0,
  max_turns         INTEGER NOT NULL DEFAULT 25,
  error_message     TEXT,
  completed_at      TIMESTAMPTZ,
  is_deleted        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_sim_run_status_check') THEN
    ALTER TABLE ao_sim_run ADD CONSTRAINT ao_sim_run_status_check
      CHECK (status IN ('running', 'completed', 'failed', 'cancelled'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_ao_sim_run_agent_created
  ON ao_sim_run (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ao_sim_run_tenant
  ON ao_sim_run (tenant_id);

-- ─── 3. ao_sim_run_scenario — one row per scenario execution ───────────────────
-- id = the per-conversation uuid AO mints in runScenario (emitted on scenario_started).
-- evaluation holds the node+goal eval object verbatim; transcript is the array of
-- turn_completed payloads exactly as emitted to the :RESULTS stream.

CREATE TABLE IF NOT EXISTS ao_sim_run_scenario (
  id              UUID PRIMARY KEY,
  sim_run_id      UUID NOT NULL,       -- → ao_sim_run.id (soft ref, no hard FK)
  scenario_ref    TEXT,                -- the scenario JSONB "id" (= ao_sim_scenario.id when persisted)
  scenario_index  INTEGER,
  status          TEXT NOT NULL DEFAULT 'running',
  stop_reason     TEXT,
  turn_count      INTEGER,
  evaluation      JSONB,
  eval_error      BOOLEAN NOT NULL DEFAULT FALSE,
  error           TEXT,
  transcript      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_sim_run_scenario_status_check') THEN
    ALTER TABLE ao_sim_run_scenario ADD CONSTRAINT ao_sim_run_scenario_status_check
      CHECK (status IN ('running', 'completed', 'error'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_ao_sim_run_scenario_run
  ON ao_sim_run_scenario (sim_run_id);
