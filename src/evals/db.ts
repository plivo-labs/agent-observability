import { sql } from "../db.js";
import { escapeLikePattern } from "../response.js";
import type {
  EvalCase,
  EvalPayloadV0,
  CaseStatus,
} from "./schema.js";
import { computeCaseMetrics, ensurePricesLoaded } from "./summarize.js";
export { summarize } from "./summarize.js";
export type { RunSummary } from "./summarize.js";

// Sentinel value used in the URL/agents endpoint to represent rows with NULL agent_id.
export const UNKNOWN_AGENT_ID = "__unknown__";

// Source of truth for run status values — mirrors the status enum in schema.ts.
const RUN_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  queued: "queued",
} as const;

// ── Insert ──────────────────────────────────────────────────────────────────

export async function insertEvalRun(payload: EvalPayloadV0): Promise<void> {
  const { run, cases } = payload;

  const startedAt = new Date(run.started_at * 1000);
  const finishedAt = run.finished_at != null ? new Date(run.finished_at * 1000) : null;
  const durationMs = run.finished_at != null
    ? Math.max(0, Math.round((run.finished_at - run.started_at) * 1000))
    : null;
  const runStatus = run.status
    ?? (run.finished_at != null ? "completed" : "running");
  const lastHeartbeatAt = new Date();

  await ensurePricesLoaded();
  const caseMetrics = cases.map((c) => computeCaseMetrics(c.events ?? []));

  await sql.begin(async (tx: any) => {
    await tx`
      INSERT INTO eval_runs (
        run_id, name, account_id, agent_id,
        framework, framework_version,
        testing_framework, testing_framework_version,
        started_at, finished_at, duration_ms, status, last_heartbeat_at,
        total, passed, failed, errored, skipped,
        ci, raw_payload,
        ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
        ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
        prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
      ) VALUES (
        ${run.run_id},
        ${run.name ?? null},
        ${run.account_id ?? null},
        ${run.agent_id ?? null},
        ${run.framework ?? null},
        ${run.framework_version ?? null},
        ${run.testing_framework},
        ${run.testing_framework_version ?? null},
        ${startedAt},
        ${finishedAt},
        ${durationMs},
        ${runStatus},
        ${lastHeartbeatAt},
        0, 0, 0, 0, 0,
        ${run.ci != null ? JSON.stringify(run.ci) : null}::jsonb,
        ${JSON.stringify(payload)}::jsonb,
        NULL, NULL, NULL,
        NULL, NULL, NULL,
        0, 0, 0, 0, NULL
      )
      ON CONFLICT (run_id) DO UPDATE SET
        started_at        = LEAST(eval_runs.started_at, EXCLUDED.started_at),
        finished_at       = CASE
          WHEN eval_runs.finished_at IS NULL THEN EXCLUDED.finished_at
          WHEN EXCLUDED.finished_at IS NULL THEN eval_runs.finished_at
          ELSE GREATEST(eval_runs.finished_at, EXCLUDED.finished_at)
        END,
        duration_ms       = CASE
          WHEN eval_runs.duration_ms IS NULL THEN EXCLUDED.duration_ms
          WHEN EXCLUDED.duration_ms IS NULL THEN eval_runs.duration_ms
          ELSE GREATEST(eval_runs.duration_ms, EXCLUDED.duration_ms)
        END,
        -- Status literals below must match RUN_STATUS const (source of truth: schema.ts enum).
        status            = CASE
          WHEN eval_runs.status IN ('completed', 'failed', 'cancelled')
            AND EXCLUDED.status IN ('queued', 'running')
            THEN eval_runs.status
          ELSE EXCLUDED.status
        END,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        -- first writer wins for identity/metadata fields
        name                       = COALESCE(eval_runs.name, EXCLUDED.name),
        account_id                 = COALESCE(eval_runs.account_id, EXCLUDED.account_id),
        agent_id                   = COALESCE(eval_runs.agent_id, EXCLUDED.agent_id),
        framework                  = COALESCE(eval_runs.framework, EXCLUDED.framework),
        framework_version          = COALESCE(eval_runs.framework_version, EXCLUDED.framework_version),
        testing_framework          = COALESCE(eval_runs.testing_framework, EXCLUDED.testing_framework),
        testing_framework_version  = COALESCE(eval_runs.testing_framework_version, EXCLUDED.testing_framework_version),
        ci                         = COALESCE(eval_runs.ci, EXCLUDED.ci),
        raw_payload                = COALESCE(eval_runs.raw_payload, EXCLUDED.raw_payload)
        -- counters/metrics are no longer maintained here; computed on read from eval_cases
    `;

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const m = caseMetrics[i];
      const caseDurationMs = c.duration_ms
        ?? (c.started_at != null && c.finished_at != null
          ? Math.max(0, Math.round((c.finished_at - c.started_at) * 1000))
          : null);

      await tx`
        INSERT INTO eval_cases (
          case_id, run_id, name, file, status, duration_ms,
          user_input, events, judgments, failure,
          ttft_p50_ms, ttft_p95_ms, ttft_avg_ms,
          ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms,
          turn_count, tool_call_count, interruption_count,
          agent_handoff_count, ttft_sample_count,
          prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
        ) VALUES (
          ${c.case_id},
          ${run.run_id},
          ${c.name},
          ${c.file ?? null},
          ${c.status},
          ${caseDurationMs},
          ${c.user_input ?? null},
          ${JSON.stringify(c.events ?? [])}::jsonb,
          ${JSON.stringify(c.judgments ?? [])}::jsonb,
          ${c.failure != null ? JSON.stringify(c.failure) : null}::jsonb,
          ${m.ttft_p50_ms},
          ${m.ttft_p95_ms},
          ${m.ttft_avg_ms},
          ${m.ttfb_p50_ms},
          ${m.ttfb_p95_ms},
          ${m.ttfb_avg_ms},
          ${m.turn_count},
          ${m.tool_call_count},
          ${m.interruption_count},
          ${m.agent_handoff_count},
          ${m.ttft_sample_count},
          ${m.prompt_tokens},
          ${m.cached_prompt_tokens},
          ${m.completion_tokens},
          ${m.total_tokens},
          ${m.estimated_cost_usd}
        )
        ON CONFLICT (case_id) DO UPDATE SET
          name                 = EXCLUDED.name,
          file                 = EXCLUDED.file,
          status               = EXCLUDED.status,
          duration_ms          = EXCLUDED.duration_ms,
          user_input           = EXCLUDED.user_input,
          events               = EXCLUDED.events,
          judgments            = EXCLUDED.judgments,
          failure              = EXCLUDED.failure,
          ttft_p50_ms          = EXCLUDED.ttft_p50_ms,
          ttft_p95_ms          = EXCLUDED.ttft_p95_ms,
          ttft_avg_ms          = EXCLUDED.ttft_avg_ms,
          ttfb_p50_ms          = EXCLUDED.ttfb_p50_ms,
          ttfb_p95_ms          = EXCLUDED.ttfb_p95_ms,
          ttfb_avg_ms          = EXCLUDED.ttfb_avg_ms,
          turn_count           = EXCLUDED.turn_count,
          tool_call_count      = EXCLUDED.tool_call_count,
          interruption_count   = EXCLUDED.interruption_count,
          agent_handoff_count  = EXCLUDED.agent_handoff_count,
          ttft_sample_count    = EXCLUDED.ttft_sample_count,
          prompt_tokens        = EXCLUDED.prompt_tokens,
          cached_prompt_tokens = EXCLUDED.cached_prompt_tokens,
          completion_tokens    = EXCLUDED.completion_tokens,
          total_tokens         = EXCLUDED.total_tokens,
          estimated_cost_usd   = EXCLUDED.estimated_cost_usd
      `;
    }
  });
}

// ── Queries ─────────────────────────────────────────────────────────────────

export interface ListEvalRunsOpts {
  limit: number;
  offset: number;
  accountId?: string | null;
  agentId?: string | null;
  agentIdExact?: string | null;
  /** Multi-value — `framework IN (...)` when non-empty. Filters on the
   *  agent framework (`livekit` / `pipecat` / …). */
  frameworks?: string[] | null;
  /** Multi-value — `testing_framework IN (...)` when non-empty. Filters
   *  on the test framework (`pytest` / `vitest` / …). */
  testingFrameworks?: string[] | null;
  startedFrom?: string | null;
  startedTo?: string | null;
}

export async function countEvalRuns(opts: ListEvalRunsOpts): Promise<number> {
  const { predicates, params } = buildPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const [row] = await sql.unsafe(
    `SELECT count(*)::int AS total FROM eval_runs ${whereClause}`,
    params,
  );
  return row.total;
}

const RUN_BIGINT_FIELDS = ["duration_ms", "prompt_tokens", "cached_prompt_tokens", "completion_tokens", "total_tokens"] as const;
const CASE_BIGINT_FIELDS = ["duration_ms", "prompt_tokens", "cached_prompt_tokens", "completion_tokens", "total_tokens", "turn_count", "tool_call_count", "interruption_count", "agent_handoff_count", "ttft_sample_count"] as const;

function parseRunRow(row: any): any {
  for (const f of RUN_BIGINT_FIELDS) {
    if (row[f] != null) row[f] = Number(row[f]);
  }
  return row;
}

function parseCaseRow(row: any): any {
  for (const f of CASE_BIGINT_FIELDS) {
    if (row[f] != null) row[f] = Number(row[f]);
  }
  return row;
}

// Counters and latency/cost metrics are derived from eval_cases on read.
// Run-level ttft/ttfb percentiles are approximations (PERCENTILE over per-case averages).
const DERIVED_COLS = `
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

const RUN_SELECT_COLS = `${RUN_BASE_COLS}, ${RUN_DERIVED_COLS}`;

const CASE_SELECT_COLS =
  "case_id, run_id, name, file, status, duration_ms, user_input, " +
  "events, judgments, failure, created_at, " +
  "ttft_p50_ms, ttft_p95_ms, ttft_avg_ms, " +
  "ttfb_p50_ms, ttfb_p95_ms, ttfb_avg_ms, " +
  "turn_count, tool_call_count, interruption_count, " +
  "agent_handoff_count, ttft_sample_count, " +
  "prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd";

export async function listEvalRuns(opts: ListEvalRunsOpts): Promise<any[]> {
  const { predicates, params } = buildPredicates(opts);
  const whereClause = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const rows = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}
     FROM eval_runs
     ${DERIVED_COLS}
     ${whereClause}
     ORDER BY eval_runs.started_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  return rows.map(parseRunRow);
}

export async function getEvalRun(runId: string): Promise<any | null> {
  const rows = await sql.unsafe(
    `SELECT ${RUN_SELECT_COLS}
     FROM eval_runs
     ${DERIVED_COLS}
     WHERE eval_runs.run_id = $1
     LIMIT 1`,
    [runId],
  );
  return rows[0] ? parseRunRow(rows[0]) : null;
}

export async function listEvalCases(runId: string): Promise<any[]> {
  const rows = await sql.unsafe(
    `SELECT ${CASE_SELECT_COLS}
     FROM eval_cases
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId],
  );
  return rows.map(decodeCaseJsonb).map(parseCaseRow);
}

export async function getEvalCase(runId: string, caseId: string): Promise<any | null> {
  const rows = await sql.unsafe(
    `SELECT ${CASE_SELECT_COLS}
     FROM eval_cases
     WHERE run_id = $1 AND case_id = $2
     LIMIT 1`,
    [runId, caseId],
  );
  return rows[0] ? decodeCaseJsonb(rows[0]) : null;
}

// `eval_cases.run_id` has ON DELETE CASCADE, so deleting runs cleans
// up their cases automatically.
export async function deleteEvalRuns(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  // `${runIds}::uuid[]` would let Bun stringify the array as a CSV which
  // Postgres rejects ("malformed array literal"). Bind each id as its own
  // ::uuid placeholder via sql.unsafe, the same pattern the list filters use.
  const placeholders = runIds.map((_, i) => `$${i + 1}::uuid`).join(", ");
  const rows = await sql.unsafe(
    `DELETE FROM eval_runs
     WHERE run_id IN (${placeholders})
     RETURNING run_id`,
    runIds,
  );
  return rows.length;
}

export async function deleteEvalCases(runId: string, caseIds: string[]): Promise<number> {
  if (caseIds.length === 0) return 0;
  const placeholders = caseIds.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await sql.unsafe(
    `DELETE FROM eval_cases
     WHERE run_id = $1 AND case_id IN (${placeholders})
     RETURNING case_id`,
    [runId, ...caseIds],
  );
  return rows.length;
}

// ── Stale-run sweeper ────────────────────────────────────────────────────────

export async function sweepStaleRuns(): Promise<number> {
  const rows = await sql.unsafe(
    `UPDATE eval_runs
     SET status = $1, finished_at = COALESCE(finished_at, now())
     WHERE status = $2 AND last_heartbeat_at < now() - interval '60 seconds'
     RETURNING run_id`,
    [RUN_STATUS.failed, RUN_STATUS.running],
  );
  return rows.length;
}

// ── Agents aggregation ──────────────────────────────────────────────────────

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

export interface AgentRow {
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

export async function listEvalAgents(): Promise<AgentRow[]> {
  // Aggregate per agent_id (NULL → '__unknown__'), join a lateral subquery
  // for the last-10-run pass-rate trend. Counters derived from eval_cases.
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
      -- Subset of DERIVED_COLS (no tokens/cost); kept separate because DERIVED_COLS
      -- references eval_runs.run_id by name and cannot be reused inside a CTE alias.
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
        -- TODO(perf): collapse per-run percentile then AVG into single GROUP BY over eval_cases
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

  return rows.map((r: any) => ({
    agent_id: r.agent_id,
    run_count: r.run_count,
    last_run_at: r.last_run_at instanceof Date ? r.last_run_at.toISOString() : r.last_run_at,
    avg_pass_rate: r.avg_pass_rate != null ? Number(r.avg_pass_rate) : 0,
    last_pass_rate: r.last_pass_rate != null ? Number(r.last_pass_rate) : 0,
    ttft_p95_ms: r.ttft_p95_ms != null ? Number(r.ttft_p95_ms) : null,
    ttfb_p95_ms: r.ttfb_p95_ms != null ? Number(r.ttfb_p95_ms) : null,
    total_cases: r.total_cases ?? 0,
    total_passed: r.total_passed ?? 0,
    total_failed: r.total_failed ?? 0,
    framework: r.framework ?? null,
    trend: Array.isArray(r.trend)
      ? r.trend
      : typeof r.trend === "string"
        ? JSON.parse(r.trend)
        : [],
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildPredicates(opts: ListEvalRunsOpts): { predicates: string[]; params: unknown[] } {
  const predicates: string[] = [];
  const params: unknown[] = [];
  // Free-text filters use lower-cased substring LIKE — case-insensitive,
  // forgiving of partial matches. Loses index usage on `account_id` /
  // `agent_id`; revisit with a pg_trgm GIN index if filter latency
  // matters at higher row counts.
  if (opts.accountId) {
    predicates.push(`LOWER(eval_runs.account_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.accountId.toLowerCase())}%`);
  }
  const agentId = opts.agentIdExact ?? opts.agentId;
  if (agentId === UNKNOWN_AGENT_ID) {
    predicates.push(`eval_runs.agent_id IS NULL`);
  } else if (opts.agentIdExact) {
    predicates.push(`eval_runs.agent_id = $${params.length + 1}`);
    params.push(opts.agentIdExact);
  } else if (opts.agentId) {
    predicates.push(`LOWER(eval_runs.agent_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.agentId.toLowerCase())}%`);
  }
  if (opts.frameworks && opts.frameworks.length > 0) {
    const placeholders = opts.frameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`eval_runs.framework IN (${placeholders.join(", ")})`);
    params.push(...opts.frameworks);
  }
  if (opts.testingFrameworks && opts.testingFrameworks.length > 0) {
    const placeholders = opts.testingFrameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`eval_runs.testing_framework IN (${placeholders.join(", ")})`);
    params.push(...opts.testingFrameworks);
  }
  if (opts.startedFrom) {
    predicates.push(`eval_runs.started_at >= $${params.length + 1}`);
    params.push(opts.startedFrom);
  }
  if (opts.startedTo) {
    predicates.push(`eval_runs.started_at <= $${params.length + 1}`);
    params.push(opts.startedTo);
  }
  return { predicates, params };
}

function decodeCaseJsonb(row: any): any {
  return {
    ...row,
    events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
    judgments: typeof row.judgments === "string" ? JSON.parse(row.judgments) : row.judgments,
    failure: typeof row.failure === "string" ? JSON.parse(row.failure) : row.failure,
  };
}

// Re-exports for convenience
export type { EvalCase, CaseStatus };
