-- Conversation-goal analysis tracking (spec:
-- docs/superpowers/specs/2026-06-11-transcript-search-and-goals-design.md
-- part 2). One row per analyzed (or attempted) session; the ABSENCE of a
-- row means "never attempted" — ingest stays untouched, eligibility is
-- derived from data that already exists (goal: tags + transcript_text).
--
-- States: 'claimed' (an analyzer is on it; stale after 10 minutes),
-- 'done' (verdicts written to session_external_evals, source='goal'),
-- 'error' (retried until attempts reaches 3). The claim is an atomic
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING so the API-inline
-- analyzer and the dedicated worker can run concurrently without
-- double-analyzing (and double-paying for) a session.

CREATE TABLE IF NOT EXISTS session_goal_analyses (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'done', 'error')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_at TIMESTAMPTZ,
  analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
