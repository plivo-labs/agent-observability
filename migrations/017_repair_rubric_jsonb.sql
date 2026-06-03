-- Repair double-encoded rubric jsonb.
--
-- Earlier rubric writes bound `${JSON.stringify(value)}::jsonb`, which bun:sql
-- double-encodes: the stringified JSON is stored as a jsonb STRING scalar
-- (e.g. "[{...}]") instead of a real jsonb array. The read path masks it
-- (parseJson re-parses the string), but raw jsonb operators throw
-- ("cannot get array length of a scalar"), and migration 015's array-based
-- backfill silently skipped string-scalar `axes` rows (e.g. "Safety &
-- guardrails"), leaving them with zero criteria.
--
-- `value #>> '{}'` extracts a jsonb string scalar's content as text; casting
-- that text back to ::jsonb parses it into the real array. No-ops on rows that
-- are already arrays (guarded by jsonb_typeof = 'string').

-- 1. Un-double-encode string-scalar criteria → real jsonb array.
UPDATE sim_rubrics
SET criteria = (criteria #>> '{}')::jsonb
WHERE jsonb_typeof(criteria) = 'string';

-- 2. Un-double-encode string-scalar axes → real jsonb array.
UPDATE sim_rubrics
SET axes = (axes #>> '{}')::jsonb
WHERE jsonb_typeof(axes) = 'string';

-- 3. Re-run the 015 backfill for rows whose criteria is still empty but whose
--    axes is now a real array (these were skipped in 015 because axes was a
--    string scalar at the time — e.g. "Safety & guardrails").
UPDATE sim_rubrics
SET criteria = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'name', axis->>'name',
        'question', 'Did the agent satisfy: ' || (axis->>'name') || '?',
        'weight', COALESCE((axis->>'weight')::numeric, 1)
      )
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(axes) AS axis
)
-- Guard ONLY on jsonb_typeof(axes) = 'array' (same lesson as 015): AND does not
-- short-circuit, so adding jsonb_array_length(axes) here would let Postgres
-- evaluate it on scalar/null-axes rows and throw. Empty-array axes harmlessly
-- backfill to [] via the COALESCE above.
WHERE (criteria IS NULL OR criteria = '[]'::jsonb)
  AND jsonb_typeof(axes) = 'array';
