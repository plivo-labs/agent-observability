-- Backfill agent_transport_sessions.turn_count to the assistant-message
-- count.
--
-- src/parse.ts historically incremented turn_count on every chat message
-- item (user + assistant), while src/metrics.ts only counts assistant
-- messages when computing summary.total_turns. Two surfaces, two
-- semantics — the sessions-list "Turns" column showed 8 while the
-- session-detail KPI tile showed 4 for the same 4-turn dialog.
--
-- The ingest handler now only counts assistant messages (matches
-- metrics.ts); this migration aligns existing rows so the agent-overview
-- "avg X turns" subtext and any future aggregations agree with the
-- per-session KPI. "Turn" universally means a logical user→assistant
-- pair in conversation analytics, so the assistant count is canonical.
--
-- Idempotent: only updates rows where the stored count differs from the
-- recomputed value. Skips rows without chat_history.

WITH recounted AS (
  SELECT
    s.id,
    COUNT(*) FILTER (
      WHERE (item->>'type') = 'message'
        AND (item->>'role') = 'assistant'
    )::int AS new_turn_count
  FROM agent_transport_sessions s,
       jsonb_array_elements(
         CASE WHEN jsonb_typeof(s.chat_history) = 'array'
              THEN s.chat_history
              ELSE '[]'::jsonb
         END
       ) AS item
  WHERE s.chat_history IS NOT NULL
  GROUP BY s.id
)
UPDATE agent_transport_sessions AS s
SET turn_count = r.new_turn_count
FROM recounted r
WHERE s.id = r.id
  AND s.turn_count IS DISTINCT FROM r.new_turn_count;
