-- Estimated USD cost per case and per run. Computed server-side from
-- tokens (S5) and model pricing (src/evals/pricing.ts → models.dev with
-- in-memory cache + static seed fallback).
--
-- NULL means "we had tokens we couldn't price" (mixed-model runs where
-- at least one model isn't in the pricing table). 0 means "no tokens
-- to price" (e.g. running-POST snapshot). A positive number is the
-- computed sum. Distinguishing null vs 0 matters in the UI — null
-- renders an em-dash, 0 renders "$0.00".
--
-- DOUBLE PRECISION is sufficient — USD cost arithmetic is approximate
-- (prices change, token counts have provider-side wiggle).

ALTER TABLE eval_cases
  ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION;

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION;
