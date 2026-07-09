-- Supervisor layer: a second-pass model re-judges each stored verdict axis and
-- records where it disagrees (a "misflag"), plus a suggested judge-prompt fix.
-- The Supervisor tab reads these, grouped by judge axis.
--
-- Review claim state lives on the existing verdicts table (no second queue):
-- the supervisor sweeper claims rows WHERE status='done' AND review_status IS NULL.
ALTER TABLE ao_session_eval_verdicts
  ADD COLUMN IF NOT EXISTS review_status     TEXT,           -- NULL=unreviewed | 'running' | 'done' | 'error'
  ADD COLUMN IF NOT EXISTS review_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_error      TEXT;

-- Claim lookup: done-but-unreviewed, newest-completed first. The sort column
-- MUST match claimNextReview's `ORDER BY completed_at DESC NULLS LAST`
-- (supervisor/db.ts) or the planner can't use this index to serve the sort.
CREATE INDEX IF NOT EXISTS ao_eval_verdicts_review_claim_idx
  ON ao_session_eval_verdicts (completed_at DESC NULLS LAST)
  WHERE status = 'done' AND review_status IS NULL;

-- One row per (session, judge axis, node). node_ref = '' for conversation/goal axes.
CREATE TABLE IF NOT EXISTS ao_session_eval_reviews (
  id                  SERIAL PRIMARY KEY,
  session_id          TEXT NOT NULL,
  axis                TEXT NOT NULL,               -- e.g. 'bot_detection', 'instructions_adherence'
  node_ref            TEXT NOT NULL DEFAULT '',    -- node axes carry the node ref; conversation/goal = ''
  node_name           TEXT,
  original_verdict    TEXT,                        -- primary judge, normalized to 'flagged' | 'clear' (reviewer.ts)
  original_reason     TEXT,
  supervisor_verdict  TEXT,                        -- supervisor's independent re-decision, also 'flagged' | 'clear'
  supervisor_reason   TEXT,
  agreement           BOOLEAN NOT NULL,            -- false = MISFLAG
  votes_for           INTEGER NOT NULL DEFAULT 1,  -- N-vote self-consistency: votes matching supervisor_verdict
  votes_total         INTEGER NOT NULL DEFAULT 1,
  suggested_fix       JSONB,                       -- {add:[...], remove:[...], rationale:""} — populated on misflag
  supervisor_model    TEXT,
  observed_at         TIMESTAMPTZ,                 -- call time (windowing); mirrors the verdict's completed_at
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ao_uq_eval_reviews_session_axis_node UNIQUE (session_id, axis, node_ref)
);

-- Group-by-judge (the tab's top level) + misflag filter.
CREATE INDEX IF NOT EXISTS ao_eval_reviews_axis_idx    ON ao_session_eval_reviews (axis);
CREATE INDEX IF NOT EXISTS ao_eval_reviews_misflag_idx ON ao_session_eval_reviews (axis, agreement);
CREATE INDEX IF NOT EXISTS ao_eval_reviews_session_idx ON ao_session_eval_reviews (session_id);
