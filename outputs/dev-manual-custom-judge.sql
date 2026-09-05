-- ═══════════════════════════════════════════════════════════════════════════
-- Manually add + wire ONE custom judge on dev, then a call will judge with it.
-- Run on the dev core DB (contacto_dev). The deployed build already runs
-- mapped custom judges alongside the defaults.
-- ═══════════════════════════════════════════════════════════════════════════

-- STEP 1 — pick an agent that is actively getting calls (copy an agent_id):
SELECT agent_id, agent_name, COUNT(*) AS sessions_last_3h
FROM ao_agent_transport_sessions
WHERE ended_at > NOW() - interval '3 hours' AND agent_id IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC
LIMIT 8;

-- STEP 2 — replace <AGENT_ID> below with the agent you will call, then run this
-- ONE statement: it creates the judge AND maps it to that agent (enabled).
WITH new_judge AS (
  INSERT INTO ao_judges (name, display_name, description, type, scope, kind, prompt, config, enabled)
  VALUES (
    'metric:hold_announced_before_holding',
    'Hold announced before holding',
    $desc$Fail if the agent placed the caller on hold, or said it would, without stating how long — or continued after the caller objected to being put on hold. Pass if no hold occurred, or every hold was announced with a duration.$desc$,
    'custom', 'conversation', 'llm',
    jsonb_build_object(
      'body', $desc$Fail if the agent placed the caller on hold, or said it would, without stating how long — or continued after the caller objected to being put on hold. Pass if no hold occurred, or every hold was announced with a duration.$desc$,
      'output', $out$

Judge ONLY what the metric description above asks about — everything else is out of scope. Base the verdict strictly on the transcript evidence; never assume unstated facts. "unknown" is the honest verdict when the call never reached the situation the metric describes, or the evidence is insufficient to decide.

Return ONLY a JSON object: {"verdict": "pass"|"fail"|"unknown", "reason": string, "technical_reason": string}. `reason` is a short human explanation quoting the deciding evidence; `technical_reason` is the internal rationale.$out$,
      'slots', '[]'::jsonb
    ),
    '{}'::jsonb,
    TRUE
  )
  RETURNING id
)
INSERT INTO ao_agent_judges (agent_id, judge_id, enabled)
SELECT '<AGENT_ID>', id, TRUE FROM new_judge
RETURNING agent_id, judge_id, enabled;

-- STEP 3 — make a test call on that agent (your normal dev flow). Wait ~1 min.

-- STEP 4 — see the custom verdict land next to the defaults:
--   (replace <AGENT_ID> again)
SELECT e.judge_name, e.verdict, LEFT(e.reasoning, 120) AS reason, s.session_id
FROM ao_session_external_evals e
JOIN ao_agent_transport_sessions s ON s.session_id = e.session_id
WHERE s.agent_id = '<AGENT_ID>'
  AND e.created_at > NOW() - interval '15 minutes'
ORDER BY e.session_id, e.judge_name;

-- CLEANUP when done (removes the judge + its mapping):
-- DELETE FROM ao_judges WHERE name = 'metric:hold_announced_before_holding';
