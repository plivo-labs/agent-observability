-- AO Simulation Engine — AO-owned tables (plan.md Phase 0.5, AD-1).
--
-- AO owns the generated scenario *library*. It stores the agent as a plain
-- `agent_id` (= phlo_uuid) TEXT column with NO FK: aiassist's simulation_*
-- tables carry `flow_id BIGINT NOT NULL REFERENCES phlo(id)`, and resolving
-- phlo_uuid → phlo.id would force a read of the CX `phlo` table — which AO is
-- forbidden to do. The `ao_` prefix guarantees no collision with aiassist's
-- `simulation_*`.
--
-- AO does NOT store run history or per-scenario run results — that lives in a
-- separate service. This migration creates only the scenario library.
--
-- All identifying inputs (account_id, agent_id, the scenario/flow JSON) arrive via
-- the HTTP request — HTTP is AO's only data boundary.
--
-- Deployment (AD-1): OSS applies this file via AO's own migrator
-- (AUTO_MIGRATE=on, its own DB). Plivo ships a byte-identical copy as a
-- contacto-core-db Goose migration (AO runs DML-only, AUTO_MIGRATE=off, under a
-- least-privilege ao_user role).
--
-- Every CREATE uses IF NOT EXISTS; CHECKs use existence guards. Safe to re-run.

-- ─── ao_simulation_scenarios ──────────────────────────────────────────────────
-- The generated scenario library, keyed to an agent (NOT a run): a run selects
-- from these by id (RunScenariosRequest.scenario_uuids). `scenario` is the full
-- dict (worker SimulationScenario shape; world_state already a DICT).

CREATE TABLE IF NOT EXISTS ao_simulation_scenarios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      TEXT,
  agent_id        TEXT,              -- = phlo_uuid; NO FK to phlo (AD-1)
  name            TEXT NOT NULL,
  scenario        JSONB NOT NULL,    -- full scenario dict (post validate_and_fix)
  tags            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- JSONB (not TEXT[]): bun:sql can't bind JS arrays to PG arrays
  source          TEXT NOT NULL DEFAULT 'generated',  -- generated | manual | imported
  coverage_key    TEXT,              -- slot dedup key from the generator (AD-4)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_simulation_scenarios_source_check') THEN
    ALTER TABLE ao_simulation_scenarios ADD CONSTRAINT ao_simulation_scenarios_source_check
      CHECK (source IN ('generated', 'manual', 'imported'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_ao_sim_scenarios_account_created ON ao_simulation_scenarios (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ao_sim_scenarios_agent_created   ON ao_simulation_scenarios (agent_id, created_at DESC);
