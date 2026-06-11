-- Full-text transcript search (PLANS.md plan 4 step 1; spec:
-- docs/superpowers/specs/2026-06-11-transcript-search-and-goals-design.md).
--
-- Flattens the spoken transcript out of the chat_history JSONB into a
-- DB-owned generated column and indexes it for word search. Content only —
-- deliberately no role prefixes (so "user"/"assistant" never match a
-- query) and no tool-call payloads. The sessions endpoint queries it with
-- websearch_to_tsquery('english', $q); that expression must stay textually
-- identical to the index expression below or the planner skips the index.
--
-- extract_transcript must be IMMUTABLE (generated columns require it) —
-- it is: pure JSONB walking, no catalog or clock access. Postgres 12+.
--
-- Message `content` arrives in BOTH shapes — `content: ["text", ...]`
-- (array of fragments) and `content: "text"` (plain string; the majority
-- of sampled production rows) — so the LATERAL branches on the type.

CREATE OR REPLACE FUNCTION extract_transcript(history jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURNS NULL ON NULL INPUT AS $$
  SELECT CASE WHEN jsonb_typeof(history) = 'array' THEN
    (SELECT string_agg(part.value, E'\n' ORDER BY item.ord, part.ord)
     FROM jsonb_array_elements(history) WITH ORDINALITY AS item(value, ord),
     LATERAL (
       SELECT t.value, t.ordinality
       FROM jsonb_array_elements_text(item.value->'content') WITH ORDINALITY AS t
       WHERE jsonb_typeof(item.value->'content') = 'array'
       UNION ALL
       SELECT item.value->>'content', 1::bigint
       WHERE jsonb_typeof(item.value->'content') = 'string'
     ) AS part(value, ord)
     WHERE item.value->>'type' = 'message')
  END
$$;

-- Rewrites the table to backfill existing rows; acceptable at current scale.
ALTER TABLE agent_transport_sessions
  ADD COLUMN IF NOT EXISTS transcript_text text
  GENERATED ALWAYS AS (extract_transcript(chat_history)) STORED;

CREATE INDEX IF NOT EXISTS idx_ats_transcript_fts
  ON agent_transport_sessions USING gin (to_tsvector('english', transcript_text));
