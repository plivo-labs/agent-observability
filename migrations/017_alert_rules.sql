-- Alert rules on conversation evals + webhook delivery tracking.
--
-- Every rule is a windowed metric threshold, evaluated periodically (30s
-- sweeper), firing when the metric EXCEEDS threshold_value over the window:
--   rates (0..1):  eval_fail_rate, outcome_fail_rate, interruption_rate
--   latency (ms):  latency_perceived_p95, latency_llm_ttft_p95,
--                  latency_tts_ttfb_p95, latency_stt_p95
-- A rule that fires is suppressed for one window length (last_fired_at).
--
-- Webhook trust model: URLs are operator-configured plaintext (consistent
-- with the repo's env-var auth). Scheme is restricted to http/https at the
-- API layer; no further SSRF blocking — this is a self-hosted service
-- behind basic auth, configured by the operator.
--
-- Every CREATE uses IF NOT EXISTS; CHECKs use existence guards. Safe to
-- re-run.

-- ─── alert_rules ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alert_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  account_id          TEXT,             -- NULL = any account
  agent_id            TEXT,             -- NULL = any agent
  metric              TEXT NOT NULL,    -- see header for the list
  judge_name          TEXT,             -- eval_fail_rate only; NULL = any judge
  threshold_value     DOUBLE PRECISION NOT NULL, -- rates 0..1, latencies ms
  min_samples         INTEGER NOT NULL DEFAULT 1, -- samples required in window before the rule fires
  window_minutes      INTEGER NOT NULL,
  webhook_url         TEXT NOT NULL,
  http_method         TEXT NOT NULL DEFAULT 'POST',
  secret              TEXT,             -- optional HMAC-SHA256 signing key
  headers             JSONB,            -- optional extra request headers { "x-foo": "bar" }
  last_fired_at       TIMESTAMPTZ,      -- suppression anchor: one firing per window
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_http_method_check') THEN
    ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_http_method_check
      CHECK (http_method IN ('POST', 'PUT', 'PATCH'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_metric_check') THEN
    ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
      CHECK (metric IN (
        'eval_fail_rate', 'outcome_fail_rate',
        'latency_perceived_p95', 'latency_llm_ttft_p95',
        'latency_tts_ttfb_p95', 'latency_stt_p95',
        'interruption_rate'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_threshold_value_check') THEN
    ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_threshold_value_check
      CHECK (threshold_value > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_window_minutes_check') THEN
    ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_window_minutes_check
      CHECK (window_minutes >= 15);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_min_samples_check') THEN
    ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_min_samples_check
      CHECK (min_samples >= 1);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules (enabled) WHERE enabled;

-- ─── alert_firings ──────────────────────────────────────────────────────────
--
-- One row per rule trip. Delivery state machine: pending → delivered |
-- failed, with next_attempt_at driving the retry schedule. Claims are a
-- lease: the sweeper atomically pushes next_attempt_at forward when it
-- picks a batch (FOR UPDATE SKIP LOCKED), so concurrent sweepers never
-- double-deliver and a crash mid-delivery simply re-dues the row.

CREATE TABLE IF NOT EXISTS alert_firings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id            UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,
  matched_count      INTEGER NOT NULL,  -- matching events / metric samples in window
  total_count        INTEGER,            -- rate metrics: denominator
  observed_value     DOUBLE PRECISION,   -- the measured metric value that tripped
  sample_session_ids JSONB NOT NULL DEFAULT '[]'::jsonb, -- up to 20 matching session ids
  status             TEXT NOT NULL DEFAULT 'pending',
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at    TIMESTAMPTZ,
  response_status    INTEGER,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_firings_status_check') THEN
    ALTER TABLE alert_firings ADD CONSTRAINT alert_firings_status_check
      CHECK (status IN ('pending', 'delivered', 'failed'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_alert_firings_due  ON alert_firings (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_alert_firings_rule ON alert_firings (rule_id, created_at DESC);

-- ─── alert_webhook_attempts ─────────────────────────────────────────────────
--
-- One row per outbound HTTP attempt (including manual test sends), so the
-- dashboard can show every webhook sent and the acceptance rate over time.
-- firing_id is NULL for test sends.

CREATE TABLE IF NOT EXISTS alert_webhook_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID REFERENCES alert_rules(id) ON DELETE CASCADE,
  firing_id       UUID REFERENCES alert_firings(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'firing',  -- firing | test
  url             TEXT NOT NULL,                   -- snapshot (rule URL may change later)
  http_method     TEXT NOT NULL DEFAULT 'POST',
  attempt_number  INTEGER NOT NULL DEFAULT 1,
  ok              BOOLEAN NOT NULL,
  response_status INTEGER,
  error           TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_webhook_attempts_kind_check') THEN
    ALTER TABLE alert_webhook_attempts ADD CONSTRAINT alert_webhook_attempts_kind_check
      CHECK (kind IN ('firing', 'test'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_awa_created ON alert_webhook_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_awa_rule    ON alert_webhook_attempts (rule_id, created_at DESC);

-- ─── Window-scan indexes for the rule engine ────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_see_created ON session_external_evals (created_at);
CREATE INDEX IF NOT EXISTS idx_so_updated  ON session_outcomes (updated_at);
