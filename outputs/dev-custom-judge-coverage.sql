-- ═══════════════════════════════════════════════════════════════════════════
-- How many calls each CUSTOM metric has scored on dev, and its verdict split.
-- (Custom judges fan out under names starting 'metric:'.)
-- ═══════════════════════════════════════════════════════════════════════════

-- A) One line per custom metric: how many calls it scored + verdict breakdown
SELECT
  e.judge_name,
  COUNT(DISTINCT e.session_id)                                    AS calls_scored,
  COUNT(*) FILTER (WHERE e.verdict = 'pass')                      AS pass,
  COUNT(*) FILTER (WHERE e.verdict = 'fail')                      AS fail,
  COUNT(*) FILTER (WHERE e.verdict = 'unknown')                   AS unknown,
  MIN(e.created_at)                                               AS first_scored,
  MAX(e.created_at)                                               AS last_scored
FROM ao_session_external_evals e
WHERE e.source = 'eval_sweeper'
  AND e.judge_name LIKE 'metric:%'
GROUP BY e.judge_name
ORDER BY calls_scored DESC;

-- B) Just ONE metric (edit the name), scoped to an agent + last N days:
-- SELECT COUNT(DISTINCT e.session_id) AS calls_scored
-- FROM ao_session_external_evals e
-- JOIN ao_agent_transport_sessions s ON s.session_id = e.session_id
-- WHERE e.judge_name = 'metric:appointment_fully_confirmed'
--   AND s.agent_id = '4407eef2-4e31-4896-b745-62e167e885ba'
--   AND e.created_at > NOW() - interval '7 days';
