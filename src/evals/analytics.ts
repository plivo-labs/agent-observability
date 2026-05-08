// Counters and latency/cost metrics are derived from eval_cases on read.
// Run-level ttft/ttfb percentiles are approximations (PERCENTILE over per-case averages).
export const DERIVED_COLS = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE c.status = 'passed' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(c.judgments) = 'array' THEN c.judgments ELSE '[]'::jsonb END
        ) j WHERE j->>'verdict' = 'fail'
      ))::int AS passed,
      COUNT(*) FILTER (WHERE c.status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE c.status = 'errored')::int AS errored,
      COUNT(*) FILTER (WHERE c.status = 'skipped')::int AS skipped,
      COALESCE(SUM(c.prompt_tokens), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(c.cached_prompt_tokens), 0)::bigint AS cached_prompt_tokens,
      COALESCE(SUM(c.completion_tokens), 0)::bigint AS completion_tokens,
      COALESCE(SUM(c.total_tokens), 0)::bigint AS total_tokens,
      SUM(c.estimated_cost_usd) AS estimated_cost_usd,
      AVG(c.ttft_avg_ms) AS ttft_avg_ms,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.ttft_avg_ms) AS ttft_p50_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.ttft_avg_ms) AS ttft_p95_ms,
      AVG(c.ttfb_avg_ms) AS ttfb_avg_ms,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.ttfb_avg_ms) AS ttfb_p50_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.ttfb_avg_ms) AS ttfb_p95_ms
    FROM eval_cases c
    WHERE c.run_id = eval_runs.run_id
  ) derived ON true`;

const RUN_BASE_COLS =
  "eval_runs.run_id, eval_runs.name, eval_runs.account_id, eval_runs.agent_id, " +
  "eval_runs.framework, eval_runs.framework_version, eval_runs.testing_framework, eval_runs.testing_framework_version, " +
  "eval_runs.started_at, eval_runs.finished_at, eval_runs.duration_ms, eval_runs.status, eval_runs.last_heartbeat_at, " +
  "eval_runs.ci, eval_runs.created_at";

const RUN_DERIVED_COLS =
  "derived.total, derived.passed, derived.failed, derived.errored, derived.skipped, " +
  "derived.ttft_p50_ms, derived.ttft_p95_ms, derived.ttft_avg_ms, " +
  "derived.ttfb_p50_ms, derived.ttfb_p95_ms, derived.ttfb_avg_ms, " +
  "derived.prompt_tokens, derived.cached_prompt_tokens, derived.completion_tokens, derived.total_tokens, derived.estimated_cost_usd";

export const RUN_SELECT_COLS = `${RUN_BASE_COLS}, ${RUN_DERIVED_COLS}`;
