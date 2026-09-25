// Per-metric analytics for the AI-agent performance page: pass rate, calls,
// trend and Δ-vs-prior-window for every judge that fired — default checks and
// custom metrics alike — plus the top-line KPIs. Reads AO's own eval verdicts
// (ao_session_external_evals) joined to the sessions in the window; account +
// agent scoped like the rest of the analytics surface. Generic over AO's own
// data — nothing platform-specific.
import { sql } from "../db.js";
import { RANGE_TO_INTERVAL } from "../stats-sql.js";

export interface MetricTrendPoint {
  bucket: string;
  pass_rate: number | null;
}

export interface MetricRow {
  judge_name: string;
  display_name: string;
  scope: "node" | "conversation" | null;
  type: "default" | "custom" | null;
  calls: number;
  passed: number;
  failed: number;
  unknown: number;
  /** passed / (passed + failed), 0..1; null when nothing decided. */
  pass_rate: number | null;
  /** current pass_rate − prior-window pass_rate, in percentage POINTS. */
  delta_pts: number | null;
  trend: MetricTrendPoint[];
}

export interface MetricsAnalytics {
  range: string;
  account_id: string | null;
  agent_id: string | null;
  target: number;
  kpis: {
    overall_pass_rate: number | null;
    calls_scored: number;
    calls_in_range: number;
    default_metric_count: number;
    custom_metric_count: number;
    below_target_count: number;
  };
  default_checks: MetricRow[];
  custom_metrics: MetricRow[];
}

function rate(passed: number, failed: number): number | null {
  const d = passed + failed;
  return d > 0 ? passed / d : null;
}

export async function getMetricsAnalytics(opts: {
  range?: string;
  accountId?: string | null;
  agentIds?: string[] | null;
  target?: number;
}): Promise<MetricsAnalytics> {
  const range = RANGE_TO_INTERVAL[opts.range ?? "7d"] ? (opts.range ?? "7d") : "7d";
  const { interval, bucket } = RANGE_TO_INTERVAL[range];
  const accountId = opts.accountId ?? null;
  // Multiple selected agent flows → a Postgres text[] literal bound to `= ANY(...)`. The manual
  // literal sidesteps bun:sql's array-binding gotcha (same idiom as eval-sweeper); agent-flow
  // uuids are safe, but strip "/\ defensively. null = no agent filter (all flows).
  const agentIds = opts.agentIds && opts.agentIds.length ? opts.agentIds : null;
  const agentIdsLit = agentIds
    ? `{${agentIds.map((id) => `"${id.replace(/["\\]/g, "")}"`).join(",")}}`
    : null;
  const target = opts.target ?? 0.75;

  // Sessions in the CURRENT and PRIOR windows (prior = the same length again,
  // immediately before) so a single pass gives both the value and the delta.
  const winCte = `
    win AS (
      SELECT session_id, account_id,
        CASE WHEN ended_at >= NOW() - $1::interval THEN 'cur' ELSE 'prev' END AS period
      FROM ao_agent_transport_sessions
      WHERE ended_at >= NOW() - ($1::interval * 2)
        AND ($2::text IS NULL OR account_id = $2)
        AND ($3::text IS NULL OR agent_id = ANY($3::text[]))
    )`;

  const [aggRows, trendRows, callRows] = await Promise.all([
    sql.unsafe(
      `WITH ${winCte},
       ev AS (
         SELECT e.judge_name, e.verdict, e.session_id, e.tag, w.period, w.account_id
         FROM ao_session_external_evals e
         JOIN win w ON w.session_id = e.session_id
         WHERE e.source = 'eval_sweeper'
       )
       SELECT
         ev.judge_name,
         -- Prefer the registry's display name; if a custom's definition row is missing,
         -- prettify metric:<slug> instead of showing the raw id.
         COALESCE(
           j.display_name,
           CASE WHEN ev.judge_name LIKE 'metric:%'
                THEN initcap(replace(substring(ev.judge_name FROM 8), '_', ' '))
                ELSE ev.judge_name END
         ) AS display_name,
         -- Scope from the registry; if the definition is missing, derive it from whether the
         -- metric's verdicts carry a node tag (node-scope) or none (conversation-scope) — so a
         -- definition-less custom still shows Per node / Per call instead of "—".
         COALESCE(j.scope, CASE WHEN bool_or(ev.tag IS NOT NULL) THEN 'node' ELSE 'conversation' END) AS scope,
         COALESCE(j.type, CASE WHEN ev.judge_name LIKE 'metric:%' THEN 'custom' ELSE 'default' END) AS type,
         COUNT(*) FILTER (WHERE period = 'cur' AND verdict = 'pass')::int AS passed,
         COUNT(*) FILTER (WHERE period = 'cur' AND verdict = 'fail')::int AS failed,
         COUNT(*) FILTER (WHERE period = 'cur' AND verdict = 'unknown')::int AS unknown,
         COUNT(DISTINCT ev.session_id) FILTER (WHERE period = 'cur')::int AS calls,
         COUNT(*) FILTER (WHERE period = 'prev' AND verdict = 'pass')::int AS prev_passed,
         COUNT(*) FILTER (WHERE period = 'prev' AND verdict = 'fail')::int AS prev_failed
       FROM ev
       LEFT JOIN ao_judges j ON j.name = ev.judge_name
         AND (j.type = 'default' OR j.account_id IS NOT DISTINCT FROM ev.account_id)
       -- Only surface judges that exist in the registry (the shipped catalogue) or are real
       -- custom metrics; drop orphaned/retired verdict names (goal:*, dead_air, …) so the
       -- default count reflects the catalogue, not stale names left in the data.
       WHERE j.name IS NOT NULL OR ev.judge_name LIKE 'metric:%'
       GROUP BY ev.judge_name, j.display_name, j.scope, j.type`,
      [interval, accountId, agentIdsLit],
    ),
    sql.unsafe(
      `WITH ${winCte}
       SELECT
         e.judge_name,
         date_trunc($4, e.created_at) AS bucket_start,
         COUNT(*) FILTER (WHERE e.verdict = 'pass')::int AS passed,
         COUNT(*) FILTER (WHERE e.verdict = 'fail')::int AS failed
       FROM ao_session_external_evals e
       JOIN win w ON w.session_id = e.session_id AND w.period = 'cur'
       WHERE e.source = 'eval_sweeper'
       GROUP BY e.judge_name, date_trunc($4, e.created_at)
       ORDER BY bucket_start`,
      [interval, accountId, agentIdsLit, bucket],
    ),
    sql.unsafe(
      `WITH ${winCte}
       SELECT
         COUNT(*) FILTER (WHERE period = 'cur')::int AS calls_in_range,
         COUNT(*) FILTER (
           WHERE period = 'cur' AND session_id IN (
             SELECT DISTINCT session_id FROM ao_session_external_evals WHERE source = 'eval_sweeper'
           )
         )::int AS calls_scored
       FROM win`,
      [interval, accountId, agentIdsLit],
    ),
  ]);

  const trendByJudge = new Map<string, MetricTrendPoint[]>();
  for (const r of trendRows as Array<{ judge_name: string; bucket_start: unknown; passed: number; failed: number }>) {
    const arr = trendByJudge.get(r.judge_name) ?? [];
    arr.push({ bucket: new Date(r.bucket_start as string).toISOString(), pass_rate: rate(r.passed, r.failed) });
    trendByJudge.set(r.judge_name, arr);
  }

  const defaults: MetricRow[] = [];
  const customs: MetricRow[] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let belowTarget = 0;

  for (const r of aggRows as Array<
    MetricRow & { prev_passed: number; prev_failed: number }
  >) {
    const pass_rate = rate(r.passed, r.failed);
    const prev = rate(r.prev_passed, r.prev_failed);
    const delta_pts = pass_rate != null && prev != null ? (pass_rate - prev) * 100 : null;
    const row: MetricRow = {
      judge_name: r.judge_name,
      display_name: r.display_name,
      scope: r.scope ?? null,
      type: r.type ?? null,
      calls: r.calls,
      passed: r.passed,
      failed: r.failed,
      unknown: r.unknown,
      pass_rate,
      delta_pts,
      trend: trendByJudge.get(r.judge_name) ?? [],
    };
    totalPassed += r.passed;
    totalFailed += r.failed;
    if (pass_rate != null && pass_rate < target) belowTarget += 1;
    (row.type === "custom" ? customs : defaults).push(row);
  }

  // Worst first — the page leads with what needs fixing.
  const worstFirst = (a: MetricRow, b: MetricRow) => (a.pass_rate ?? 1) - (b.pass_rate ?? 1);
  defaults.sort(worstFirst);
  customs.sort(worstFirst);

  const counts = (callRows[0] ?? {}) as { calls_in_range?: number; calls_scored?: number };
  return {
    range,
    account_id: accountId,
    agent_id: agentIds ? agentIds.join(",") : null,
    target,
    kpis: {
      overall_pass_rate: rate(totalPassed, totalFailed),
      calls_scored: counts.calls_scored ?? 0,
      calls_in_range: counts.calls_in_range ?? 0,
      default_metric_count: defaults.length,
      custom_metric_count: customs.length,
      below_target_count: belowTarget,
    },
    default_checks: defaults,
    custom_metrics: customs,
  };
}

// The runs behind a metric — the flow_run_uuids of the sessions that FAILED this
// judge in the window, so a client can drill the metric into its runs table.
// Same account / agent / range scope as getMetricsAnalytics; generic over AO's
// own verdicts.
export interface MetricFailedRun {
  flow_run_uuid: string;
  flow_uuid: string | null;
  flow_name: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  outcome: string | null;
}

export async function getMetricFailedRuns(opts: {
  range?: string;
  accountId?: string | null;
  agentIds?: string[] | null;
  judgeName: string;
  limit?: number;
}): Promise<{ range: string; judge_name: string; flow_run_uuids: string[]; runs: MetricFailedRun[] }> {
  const range = RANGE_TO_INTERVAL[opts.range ?? "7d"] ? (opts.range ?? "7d") : "7d";
  const { interval } = RANGE_TO_INTERVAL[range];
  const accountId = opts.accountId ?? null;
  // See getMetricsAnalytics: manual text[] literal for `= ANY(...)`, or null for all flows.
  const agentIds = opts.agentIds && opts.agentIds.length ? opts.agentIds : null;
  const agentIdsLit = agentIds
    ? `{${agentIds.map((id) => `"${id.replace(/["\\]/g, "")}"`).join(",")}}`
    : null;
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);

  // The tag name is `flow_run_uuid:<uuid>`; substring FROM 15 drops the prefix.
  const rows = await sql.unsafe(
    `SELECT DISTINCT ON (substring(t.name FROM 15)) substring(t.name FROM 15) AS flow_run_uuid,
            s.agent_id AS flow_uuid, s.agent_name AS flow_name,
            s.started_at, s.ended_at, s.duration_ms,
            latest_outcome.outcome
     FROM ao_session_external_evals e
     JOIN ao_agent_transport_sessions s ON s.session_id = e.session_id
     JOIN ao_session_tags t
       ON t.session_id = e.session_id AND t.name LIKE 'flow_run_uuid:%'
     LEFT JOIN LATERAL (
       SELECT o.outcome
       FROM ao_session_outcomes o
       WHERE o.session_id = s.session_id
       ORDER BY COALESCE(o.observed_at, o.updated_at, o.created_at) DESC
       LIMIT 1
     ) latest_outcome ON TRUE
     WHERE e.source = 'eval_sweeper'
       AND e.judge_name = $1
       AND e.verdict = 'fail'
       AND s.ended_at >= NOW() - $2::interval
       AND ($3::text IS NULL OR s.account_id = $3)
       AND ($4::text IS NULL OR s.agent_id = ANY($4::text[]))
       ORDER BY substring(t.name FROM 15), e.created_at DESC
     LIMIT $5`,
    [opts.judgeName, interval, accountId, agentIdsLit, limit],
  );

  const runs = (rows as Array<any>)
    .filter((r) => r.flow_run_uuid)
    .map((r) => ({
      flow_run_uuid: r.flow_run_uuid,
      flow_uuid: r.flow_uuid ?? null,
      flow_name: r.flow_name ?? null,
      started_at: new Date(r.started_at).toISOString(),
      ended_at: new Date(r.ended_at).toISOString(),
      duration_ms: Number(r.duration_ms ?? 0),
      outcome: r.outcome ?? null,
    }));

  return {
    range,
    judge_name: opts.judgeName,
    flow_run_uuids: (rows as Array<{ flow_run_uuid: string | null }>)
      .map((r) => r.flow_run_uuid)
      .filter((v): v is string => !!v),
    runs,
  };
}
