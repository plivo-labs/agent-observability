-- Backfill agent_transport_sessions.started_at from chat_history.
--
-- LiveKit's native MetricsRecordingHeader (protobuf) leaves start_time
-- unset for some upload flows — text-only console mode is the one we've
-- hit in practice. Pre this migration, those rows landed with
-- started_at=NULL → duration_ms=NULL → empty "Started" and "Duration"
-- columns on the sessions list, empty avg-duration chart on the agent
-- overview.
--
-- The chat history's first item always carries its own created_at
-- (epoch seconds), so the earliest one is a reliable lower bound for
-- when the session began. The ingest handler (src/index.ts) now uses
-- this fallback for new uploads; this migration applies the same
-- derivation to rows that came in before the fix.
--
-- Idempotent: scopes to rows where started_at is still NULL and
-- chat_history carries items. Safe to re-run.

-- chat_history is stored as a JSONB array of items directly (the
-- parser unwraps `{items: [...]}` before insert), so walk the column
-- itself, not chat_history->'items'.
WITH starts AS (
  SELECT
    s.id,
    MIN((item->>'created_at')::float) AS first_ts
  FROM agent_transport_sessions s,
       jsonb_array_elements(
         CASE WHEN jsonb_typeof(s.chat_history) = 'array'
              THEN s.chat_history
              ELSE '[]'::jsonb
         END
       ) AS item
  WHERE s.started_at IS NULL
    AND s.chat_history IS NOT NULL
    AND (item->>'created_at') ~ '^[0-9.]+$'
  GROUP BY s.id
)
UPDATE agent_transport_sessions AS s
SET
  started_at = to_timestamp(starts.first_ts),
  duration_ms = CASE
    WHEN s.ended_at IS NOT NULL THEN
      (EXTRACT(EPOCH FROM s.ended_at) - starts.first_ts) * 1000
    ELSE NULL
  END
FROM starts
WHERE s.id = starts.id;
