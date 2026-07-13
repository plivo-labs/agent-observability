-- Namespace every AO table with an `ao_` prefix.
--
-- Why a rename (not editing the historical CREATE migrations 001–022):
--   • Historical migrations are immutable — an existing AO database has already
--     applied them, so editing those files would NOT re-run and the code (which
--     now queries `ao_`-prefixed names) would break against the old tables.
--   • A RENAME upgrades an existing database in place AND leaves a fresh
--     database (001→023) at the same end state.
--   • RENAME changes only the RELATION name — its constraints, indexes and
--     sequences keep their original (unprefixed) names (e.g. the pkey stays
--     `agent_transport_sessions_pkey`). The core-db migration (#509, as of
--     5c429f1) prefixes every constraint/index/sequence/function with `ao_`
--     too (`ao_uq_…`, `ao_extract_transcript`), so the two DBs diverge on
--     SUB-OBJECT names. That divergence is cosmetic: no runtime code depends
--     on those names (every ON CONFLICT is column-inferred).
--
-- ROLLING DEPLOY: apply during a single-version window. The renames break
-- every still-running replica of the PREVIOUS build the instant they commit
-- (its unprefixed queries 500 until the rollout completes) — take the brief
-- error window, or drain old replicas first. Compat views
-- (CREATE VIEW <old> AS SELECT * FROM ao_<old>) were considered and rejected:
-- auto-updatable views don't support INSERT … ON CONFLICT, which the previous
-- build's ingest upserts (tags/outcomes/raw-report patches) rely on — the
-- views would keep reads alive while the busiest write path still failed,
-- which is worse than an honest hard cutover.
--
-- The `ao_sim_*` tables (migrations 019/020) are already prefixed and are
-- intentionally excluded. Idempotent: only renames when the unprefixed table
-- exists and the prefixed one does not, so re-running is a no-op.
--
-- Pairs with the AO code change that queries these `ao_` names, and with
-- contacto-core-db #509 / consul-cfg #906.

DO $$
DECLARE
  t text;
  names text[] := ARRAY[
    'agent_transport_sessions',
    'agents',
    'session_tags',
    'session_outcomes',
    'session_external_evals',
    'session_raw_report_patches',
    'session_goal_analyses',
    'session_agent_config',
    'session_eval_verdicts',
    'alert_rules',
    'alert_firings',
    'alert_webhook_attempts',
    'eval_runs',
    'eval_cases'
  ];
BEGIN
  FOREACH t IN ARRAY names LOOP
    IF to_regclass(t) IS NOT NULL AND to_regclass('ao_' || t) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', t, 'ao_' || t);
    END IF;
  END LOOP;
END $$;
