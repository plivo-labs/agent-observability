-- Namespace every AO table with an `ao_` prefix.
--
-- Why a rename (not editing the historical CREATE migrations 001–022):
--   • Historical migrations are immutable — an existing AO database has already
--     applied them, so editing those files would NOT re-run and the code (which
--     now queries `ao_`-prefixed names) would break against the old tables.
--   • A RENAME upgrades an existing database in place AND leaves a fresh
--     database (001→023) at the same end state.
--   • RENAME preserves every constraint / index / sequence name, so the
--     resulting schema is byte-for-byte the shape the core-db migration
--     (contacto-core-db #509) creates directly. The two DBs stay identical.
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
