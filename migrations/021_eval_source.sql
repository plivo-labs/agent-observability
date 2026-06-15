-- Eval linkage: let an eval_runs row record where it came from and which
-- session/simulation produced it.
--
-- * source                — 'sdk' (CI uploads, today's only path),
--                           'post_conversation' (Stage 1 orchestrated eval of
--                           a real session), or 'simulation' (Stage 2).
-- * session_id            — soft link to the session an orchestrated eval ran
--                           over. Null for SDK/CI runs. FK is valid because
--                           migration 019 made session_id unique.
-- * simulation_result_id  — link to the simulation result that produced this
--                           eval (Stage 2). Null until then.

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS source               TEXT,
  ADD COLUMN IF NOT EXISTS session_id           TEXT,
  ADD COLUMN IF NOT EXISTS simulation_result_id UUID;

-- ON DELETE SET NULL: deleting a session must not cascade-delete its eval
-- history. Guarded ADD CONSTRAINT so the file is safe to re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'eval_runs_session_fkey'
  ) THEN
    ALTER TABLE eval_runs
      ADD CONSTRAINT eval_runs_session_fkey
      FOREIGN KEY (session_id)
      REFERENCES agent_transport_sessions(session_id)
      ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_eval_runs_session_id ON eval_runs (session_id);

-- Everything already in the table arrived via the SDK/CI upload path.
UPDATE eval_runs SET source = 'sdk' WHERE source IS NULL;
