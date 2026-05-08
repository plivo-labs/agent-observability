import { sql } from "../db.js";
import { DERIVED_COLS, RUN_SELECT_COLS } from "./analytics.js";
import type { ListEvalRunsOpts } from "./filter.js";
import { buildEvalRunPredicates } from "./filter.js";
import { decodeCaseJsonb, parseCaseRow, parseRunRow } from "./row-adapter.js";

const STALE_RUNNING_MS = 60_000;

type EvalRunRow = {
  status?: string;
  finished_at?: string | Date | null;
  last_heartbeat_at?: string | Date | null;
  [key: string]: unknown;
};

type EvalCaseRow = {
  [key: string]: unknown;
};

export interface EvalAgentRow {
  agent_id: string | null;
  run_count: number;
  last_run_at: string;
  avg_pass_rate: number;
  last_pass_rate: number;
  ttft_p95_ms: number | null;
  ttfb_p95_ms: number | null;
  total_cases: number;
  total_passed: number;
  total_failed: number;
  framework: string | null;
  trend: Array<{ started_at: string; pass_rate: number; run_id: string }>;
}

function deriveRunStatus(run: EvalRunRow | null): EvalRunRow | null {
  if (!run) return run;
  const stored = run.status;
  if (stored === "completed" || stored === "failed" || stored === "cancelled") {
    return run;
  }
  if ((stored === "running" || stored === "queued") && run.finished_at != null) {
    return { ...run, status: "completed" };
  }
  if (stored === "running") {
    const heartbeat = run.last_heartbeat_at ? new Date(run.last_heartbeat_at).getTime() : NaN;
    if (!Number.isNaN(heartbeat) && Date.now() - heartbeat > STALE_RUNNING_MS) {
      return { ...run, status: "failed" };
    }
  }
  return run;
}

export async function countEvalRuns(opts: ListEvalRunsOpts): Promise<number> {
  const { predicates, params } = buildEvalRunPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const [row] = await sql.unsafe(
    `SELECT count(*)::int AS total FROM eval_runs ${whereClause}`,
    params,
  );
  return Number(row?.total ?? 0);
}

export async function listEvalRuns(opts: ListEvalRunsOpts): Promise<EvalRunRow[]> {
  const { predicates, params } = buildEvalRunPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const runs = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}
     FROM eval_runs
     ${DERIVED_COLS}
     ${whereClause}
     ORDER BY eval_runs.started_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  return runs.map((row: EvalRunRow) => deriveRunStatus(parseRunRow(row) as EvalRunRow));
}

export async function getEvalRun(runId: string): Promise<EvalRunRow | null> {
  const rows = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}
     FROM eval_runs
     ${DERIVED_COLS}
     WHERE eval_runs.run_id = $1
     LIMIT 1`,
    [runId],
  );
  const run = rows[0] ? (parseRunRow(rows[0]) as EvalRunRow) : null;
  return deriveRunStatus(run);
}

export async function listEvalCases(runId: string): Promise<EvalCaseRow[]> {
  const rows = await sql.unsafe(
    `SELECT ${CASE_SELECT_COLS}
     FROM eval_cases
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId],
  );
  return rows.map(decodeCaseJsonb).map(parseCaseRow);
}

export async function getEvalCase(runId: string, caseId: string): Promise<EvalCaseRow | null> {
  const rows = await sql.unsafe(
    `SELECT ${CASE_SELECT_COLS}
     FROM eval_cases
     WHERE run_id = $1 AND case_id = $2
     LIMIT 1`,
    [runId, caseId],
  );
  return rows[0] ? parseCaseRow(decodeCaseJsonb(rows[0])) : null;
}

export async function listEvalAgents(): Promise<EvalAgentRow[]> {
  const rows = await sql.unsafe(
    `
    WITH run_stats AS (
      SELECT
        r.run_id,
        r.agent_id,
        r.started_at,
        r.framework,
        derived.total,
        derived.passed,
        derived.failed,
        derived.errored,
        derived.ttft_p95_ms,
        derived.ttfb_p95_ms
      FROM eval_runs r
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
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.ttft_avg_ms) AS ttft_p95_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.ttfb_avg_ms) AS ttfb_p95_ms
        FROM eval_cases c
        WHERE c.run_id = r.run_id
      ) derived ON true
    ),
    agg AS (
      SELECT
        agent_id,
        COUNT(*)::int                                                AS run_count,
        MAX(started_at)                                              AS last_run_at,
        CASE WHEN SUM(total) > 0
          THEN SUM(passed)::float / SUM(total) * 100
          ELSE 0
        END                                                          AS avg_pass_rate,
        SUM(total)::int                                              AS total_cases,
        SUM(passed)::int                                             AS total_passed,
        SUM(failed + errored)::int                                   AS total_failed,
        AVG(ttft_p95_ms)                                             AS ttft_p95_ms,
        AVG(ttfb_p95_ms)                                             AS ttfb_p95_ms
      FROM run_stats
      GROUP BY agent_id
    )
    SELECT
      agg.agent_id,
      agg.run_count,
      agg.last_run_at,
      agg.avg_pass_rate,
      agg.total_cases,
      agg.total_passed,
      agg.total_failed,
      agg.ttft_p95_ms,
      agg.ttfb_p95_ms,
      last_run.framework,
      last_run.last_pass_rate,
      COALESCE(trend.trend, '[]'::json) AS trend
    FROM agg
    LEFT JOIN LATERAL (
      SELECT framework,
             CASE WHEN total > 0 THEN (passed::float / total) * 100 ELSE 0 END AS last_pass_rate
      FROM run_stats r
      WHERE r.agent_id IS NOT DISTINCT FROM agg.agent_id
      ORDER BY r.started_at DESC
      LIMIT 1
    ) last_run ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(t) AS trend FROM (
        SELECT started_at,
               CASE WHEN total > 0 THEN (passed::float / total) * 100 ELSE 0 END AS pass_rate,
               run_id
        FROM run_stats r
        WHERE r.agent_id IS NOT DISTINCT FROM agg.agent_id
        ORDER BY r.started_at DESC
        LIMIT 10
      ) t
    ) trend ON TRUE
    ORDER BY agg.last_run_at DESC
    `,
    [],
  );

  return rows.map((r: Record<string, unknown>) => ({
    agent_id: r.agent_id,
    run_count: Number(r.run_count ?? 0),
    last_run_at: r.last_run_at instanceof Date ? r.last_run_at.toISOString() : r.last_run_at,
    avg_pass_rate: r.avg_pass_rate != null ? Number(r.avg_pass_rate) : 0,
    last_pass_rate: r.last_pass_rate != null ? Number(r.last_pass_rate) : 0,
    ttft_p95_ms: r.ttft_p95_ms != null ? Number(r.ttft_p95_ms) : null,
    ttfb_p95_ms: r.ttfb_p95_ms != null ? Number(r.ttfb_p95_ms) : null,
    total_cases: Number(r.total_cases ?? 0),
    total_passed: Number(r.total_passed ?? 0),
    total_failed: Number(r.total_failed ?? 0),
    framework: r.framework ?? null,
    trend: Array.isArray(r.trend)
      ? r.trend
      : typeof r.trend === "string"
        ? JSON.parse(r.trend)
        : [],
  }));
}

export interface EvalRunsStats {
  runs_24h: number;
  runs_prev_24h: number;
}

export async function getEvalRunsStats(): Promise<EvalRunsStats> {
  const rows = await sql.unsafe(
    `
    SELECT
      COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours')::int AS runs_24h,
      COUNT(*) FILTER (
        WHERE started_at > NOW() - INTERVAL '48 hours'
          AND started_at <= NOW() - INTERVAL '24 hours'
      )::int AS runs_prev_24h
    FROM eval_runs
    `,
    [],
  );
  const r = rows[0] ?? {};
  return {
    runs_24h: r.runs_24h ?? 0,
    runs_prev_24h: r.runs_prev_24h ?? 0,
  };
}

const CASE_SELECT_COLS =
  "case_id, run_id, name, file, status, duration_ms, user_input, " +
  "events, judgments, failure, created_at, " +
  "ttft_p50_ms, ttft_p95_ms, ttft_avg_ms, " +
  "ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms, " +
  "turn_count, tool_call_count, interruption_count, " +
  "agent_handoff_count, ttft_sample_count, " +
  "prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd";
