-- Full simulation report blob, so the Evals run-detail page can render a sim
-- run's complete report (overall score, pass rate, rubric axes, worst moments,
-- fixes, judge tree, engine, persona count). Populated only for simulation eval
-- runs (testing_framework = 'simulation'); null for live-call and pytest/vitest.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS sim_report JSONB;
