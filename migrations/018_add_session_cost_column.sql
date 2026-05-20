-- Per-session estimated cost. Computed server-side at multipart ingest
-- using the same `priceFor(provider, model)` path eval-runs use, then
-- stored verbatim so the agent-stats endpoint can SUM over it without
-- per-query usage walks.
--
-- Nullable: a session whose chat_history doesn't carry any priceable
-- token usage (text-only suites, missing model name) leaves it NULL.
-- The agent-stats SUM treats NULL as zero (Postgres default), which
-- matches eval-runs cost behavior. Pre-existing rows stay NULL until
-- they're re-ingested.

ALTER TABLE agent_transport_sessions
  ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION;
