-- Per-case audio recording link, so Live-call eval runs can play each call's
-- recording on the Evals page (like Truman). Populated for live-call cases from
-- the Truman recording proxy (/api/calls/audio/:trumanRunId); null for text sims
-- and code-authored (pytest/vitest) cases.
ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS recording_url TEXT;
