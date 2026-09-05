-- ═══════════════════════════════════════════════════════════════════════════
-- Add + wire a custom judge for the "clinic appointments" agent
-- (AO agent_id = flowId = 4407eef2-4e31-4896-b745-62e167e885ba), then a call will judge with it.
-- Run on contacto_dev. The deployed dev build already runs mapped custom judges.
-- ═══════════════════════════════════════════════════════════════════════════

-- STEP 1 — create the judge AND map it to the clinic agent, one statement:
WITH new_judge AS (
  INSERT INTO ao_judges (name, display_name, description, type, scope, kind, prompt, config, enabled)
  VALUES (
    $md$metric:appointment_fully_confirmed$md$, $md$Appointment fully confirmed$md$, $md$Fail if the call ended a booking without confirming ALL of these back to the caller before creating the calendar event: the specialty, the doctor, the chosen date and time, and the patient name and phone number. Pass if every required detail was read back and confirmed, or if no booking was attempted at all. Answer unknown only if the transcript is too incomplete to tell.$md$,
    'custom', 'conversation', 'llm',
    jsonb_build_object('body', $md$Fail if the call ended a booking without confirming ALL of these back to the caller before creating the calendar event: the specialty, the doctor, the chosen date and time, and the patient name and phone number. Pass if every required detail was read back and confirmed, or if no booking was attempted at all. Answer unknown only if the transcript is too incomplete to tell.$md$, 'output', $out$

Judge ONLY what the metric description above asks about — everything else is out of scope. Base the verdict strictly on the transcript evidence; never assume unstated facts. "unknown" is the honest verdict when the call never reached the situation the metric describes, or the evidence is insufficient to decide.

Return ONLY a JSON object: {"verdict": "pass"|"fail"|"unknown", "reason": string, "technical_reason": string}. `reason` is a short human explanation quoting the deciding evidence; `technical_reason` is the internal rationale.$out$, 'slots', '[]'::jsonb),
    '{}'::jsonb, TRUE
  )
  RETURNING id
)
INSERT INTO ao_agent_judges (agent_id, judge_id, enabled)
SELECT $md$4407eef2-4e31-4896-b745-62e167e885ba$md$, id, TRUE FROM new_judge
RETURNING agent_id, judge_id, enabled;

-- STEP 2 — make a test call on the clinic agent. Wait ~1 minute for the sweeper.

-- STEP 3 — see the custom verdict next to the 13 defaults:
SELECT e.judge_name, e.verdict, LEFT(e.reasoning, 140) AS reason
FROM ao_session_external_evals e
JOIN ao_agent_transport_sessions s ON s.session_id = e.session_id
WHERE s.agent_id = $md$4407eef2-4e31-4896-b745-62e167e885ba$md$
  AND e.created_at > NOW() - interval '20 minutes'
ORDER BY e.session_id DESC, e.judge_name;

-- CLEANUP when done:
-- DELETE FROM ao_judges WHERE name = $md$metric:appointment_fully_confirmed$md$;
