import { sql } from "../db.js";
import {
  ASSISTANT_MSG_WHERE,
  CHAT_HISTORY_ELEMS,
  INTERRUPTED_WHERE,
  PER_TURN_ELEMS,
  PER_TURN_MS,
  PERCEIVED_MS_SQL,
  PERCEIVED_MS_WHERE,
} from "../stats-sql.js";
import type { AlertMetric } from "./schema.js";

// ── Windowed rule evaluation ────────────────────────────────────────────────
//
// Time-driven: the sweeper calls evaluateRules() every tick. Each enabled,
// non-suppressed rule runs one aggregate query over its trailing window.
// Suppression = one firing per window length per rule (last_fired_at),
// claimed atomically inside the firing transaction.
//
// Events are scoped to a rule's agent/account via a LEFT JOIN to
// agent_transport_sessions — evals/outcomes don't carry agent_id
// themselves. Evals can arrive before their session row exists; windowed
// re-evaluation is self-healing for that race (the next tick sees the
// joined row).

interface RuleToEvaluate {
  id: string;
  trigger_type: string;
  metric: AlertMetric | null;
  judge_name: string | null;
  verdicts: unknown;
  threshold_count: number | null;
  threshold_value: number | null;
  min_samples: number;
  window_minutes: number;
  agent_id: string | null;
  account_id: string | null;
}

interface WindowResult {
  matched_count: number;
  total_count: number | null;
  observed_value: number | null;
  sample_session_ids: string[];
  fired: boolean;
}

// IMPORTANT bun:sql JSONB binding rules (verified empirically):
//   - Pass JS arrays/objects RAW — bun serializes them to proper jsonb.
//   - Never pre-JSON.stringify: the string lands as a jsonb *string*
//     scalar ("[\"fail\"]"), and containment checks silently match nothing.
//   - Never use the jsonb `?` operator in query text — bun rewrites the
//     literal `?` as a parameter placeholder. Use jsonb_exists() instead.
function verdictsList(rule: RuleToEvaluate): string[] {
  // Tolerate legacy rows where verdicts was stored as a jsonb string.
  const list = typeof rule.verdicts === "string" ? JSON.parse(rule.verdicts) : rule.verdicts;
  return Array.isArray(list) ? list : [];
}

const WINDOW_SQL = `($1 || ' minutes')::interval`;

async function evaluateCountRule(rule: RuleToEvaluate): Promise<WindowResult> {
  const isOutcome = rule.trigger_type === "outcome_count";
  // Outcomes match against the lk.-prefix-stripped value so rules store
  // normalized success|fail and match both lk.fail and fail.
  const rows = isOutcome
    ? await sql.unsafe(
        `SELECT COUNT(*)::int AS matched,
                (array_agg(DISTINCT o.session_id))[1:20] AS session_ids
         FROM session_outcomes o
         LEFT JOIN agent_transport_sessions s ON s.session_id = o.session_id
         WHERE o.updated_at > NOW() - ${WINDOW_SQL}
           AND jsonb_exists($2::jsonb, regexp_replace(LOWER(o.outcome), '^lk\\.', ''))
           AND ($3::text IS NULL OR s.agent_id = $3)
           AND ($4::text IS NULL OR s.account_id = $4)`,
        [String(rule.window_minutes), verdictsList(rule), rule.agent_id, rule.account_id],
      )
    : await sql.unsafe(
        `SELECT COUNT(*)::int AS matched,
                (array_agg(DISTINCT e.session_id))[1:20] AS session_ids
         FROM session_external_evals e
         LEFT JOIN agent_transport_sessions s ON s.session_id = e.session_id
         WHERE e.created_at > NOW() - ${WINDOW_SQL}
           AND jsonb_exists($2::jsonb, LOWER(COALESCE(e.verdict, '')))
           AND ($3::text IS NULL OR e.judge_name = $3)
           AND ($4::text IS NULL OR s.agent_id = $4)
           AND ($5::text IS NULL OR s.account_id = $5)`,
        [
          String(rule.window_minutes),
          verdictsList(rule),
          rule.judge_name,
          rule.agent_id,
          rule.account_id,
        ],
      );
  const matched = rows[0]?.matched ?? 0;
  return {
    matched_count: matched,
    total_count: null,
    // Count rules have no scalar metric — matched_count IS the signal;
    // a duplicated observed_value would just be payload noise.
    observed_value: null,
    sample_session_ids: rows[0]?.session_ids ?? [],
    fired: rule.threshold_count != null && matched >= rule.threshold_count,
  };
}

/** Rate over events: numerator/denominator with the failing sessions sampled. */
function rateResult(
  rule: RuleToEvaluate,
  total: number,
  matched: number,
  sampleIds: string[],
): WindowResult {
  const rate = total > 0 ? matched / total : null;
  return {
    matched_count: matched,
    total_count: total,
    observed_value: rate,
    sample_session_ids: sampleIds,
    fired:
      rule.threshold_value != null &&
      total >= rule.min_samples &&
      rate != null &&
      rate > rule.threshold_value,
  };
}

async function evaluateEvalFailRate(rule: RuleToEvaluate): Promise<WindowResult> {
  const rows = await sql.unsafe(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(e.verdict, '')) = 'fail')::int AS matched,
            (array_agg(DISTINCT e.session_id)
               FILTER (WHERE LOWER(COALESCE(e.verdict, '')) = 'fail'))[1:20] AS session_ids
     FROM session_external_evals e
     LEFT JOIN agent_transport_sessions s ON s.session_id = e.session_id
     WHERE e.created_at > NOW() - ${WINDOW_SQL}
       AND ($2::text IS NULL OR e.judge_name = $2)
       AND ($3::text IS NULL OR s.agent_id = $3)
       AND ($4::text IS NULL OR s.account_id = $4)`,
    [String(rule.window_minutes), rule.judge_name, rule.agent_id, rule.account_id],
  );
  const r = rows[0] ?? {};
  return rateResult(rule, r.total ?? 0, r.matched ?? 0, r.session_ids ?? []);
}

async function evaluateOutcomeFailRate(rule: RuleToEvaluate): Promise<WindowResult> {
  const rows = await sql.unsafe(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE regexp_replace(LOWER(o.outcome), '^lk\\.', '') IN ('fail', 'failure'))::int AS matched,
            (array_agg(DISTINCT o.session_id)
               FILTER (WHERE regexp_replace(LOWER(o.outcome), '^lk\\.', '') IN ('fail', 'failure')))[1:20] AS session_ids
     FROM session_outcomes o
     LEFT JOIN agent_transport_sessions s ON s.session_id = o.session_id
     WHERE o.updated_at > NOW() - ${WINDOW_SQL}
       AND ($2::text IS NULL OR s.agent_id = $2)
       AND ($3::text IS NULL OR s.account_id = $3)`,
    [String(rule.window_minutes), rule.agent_id, rule.account_id],
  );
  const r = rows[0] ?? {};
  return rateResult(rule, r.total ?? 0, r.matched ?? 0, r.session_ids ?? []);
}

async function evaluateInterruptionRate(rule: RuleToEvaluate): Promise<WindowResult> {
  const rows = await sql.unsafe(
    `WITH win AS (
       SELECT session_id, chat_history
       FROM agent_transport_sessions
       WHERE ended_at > NOW() - ${WINDOW_SQL}
         AND ($2::text IS NULL OR agent_id = $2)
         AND ($3::text IS NULL OR account_id = $3)
     )
     SELECT COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE})::int AS total,
            COUNT(*) FILTER (WHERE ${ASSISTANT_MSG_WHERE} AND ${INTERRUPTED_WHERE})::int AS matched,
            (array_agg(DISTINCT win.session_id)
               FILTER (WHERE ${ASSISTANT_MSG_WHERE} AND ${INTERRUPTED_WHERE}))[1:20] AS session_ids
     FROM win, ${CHAT_HISTORY_ELEMS("win.chat_history")} AS item`,
    [String(rule.window_minutes), rule.agent_id, rule.account_id],
  );
  const r = rows[0] ?? {};
  return rateResult(rule, r.total ?? 0, r.matched ?? 0, r.session_ids ?? []);
}

// Metric → per-turn SQL expression. Perceived keeps its canonical
// fallback definition; the single-field metrics come from the shared
// PER_TURN_MS fragment so dashboards and alerts can't drift.
const LATENCY_SQL: Record<string, { value: string; where: string }> = {
  latency_perceived_p95: { value: PERCEIVED_MS_SQL, where: PERCEIVED_MS_WHERE },
  latency_llm_ttft_p95: PER_TURN_MS("llm_node_ttft"),
  latency_tts_ttfb_p95: PER_TURN_MS("tts_node_ttfb"),
  latency_stt_p95: PER_TURN_MS("transcription_delay"),
};

async function evaluateLatencyP95(rule: RuleToEvaluate): Promise<WindowResult> {
  const expr = LATENCY_SQL[rule.metric!];
  const rows = await sql.unsafe(
    `WITH win AS (
       SELECT session_id, session_metrics
       FROM agent_transport_sessions
       WHERE ended_at > NOW() - ${WINDOW_SQL}
         AND ($2::text IS NULL OR agent_id = $2)
         AND ($3::text IS NULL OR account_id = $3)
     ),
     turns AS (
       SELECT win.session_id, ${expr.value} AS value_ms
       FROM win, ${PER_TURN_ELEMS("win.session_metrics")} AS m
       WHERE ${expr.where}
     )
     SELECT COUNT(*)::int AS samples,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY value_ms)::float AS p95,
            (array_agg(DISTINCT session_id) FILTER (WHERE value_ms > $4))[1:20] AS session_ids
     FROM turns`,
    [String(rule.window_minutes), rule.agent_id, rule.account_id, rule.threshold_value],
  );
  const r = rows[0] ?? {};
  const samples = r.samples ?? 0;
  const p95 = r.p95 != null ? Number(r.p95) : null;
  return {
    matched_count: samples,
    total_count: samples,
    observed_value: p95,
    sample_session_ids: r.session_ids ?? [],
    fired:
      rule.threshold_value != null &&
      samples >= rule.min_samples &&
      p95 != null &&
      p95 > rule.threshold_value,
  };
}


function evaluateMetricRule(rule: RuleToEvaluate): Promise<WindowResult> {
  switch (rule.metric) {
    case "eval_fail_rate":
      return evaluateEvalFailRate(rule);
    case "outcome_fail_rate":
      return evaluateOutcomeFailRate(rule);
    case "interruption_rate":
      return evaluateInterruptionRate(rule);
    case "latency_perceived_p95":
    case "latency_llm_ttft_p95":
    case "latency_tts_ttfb_p95":
    case "latency_stt_p95":
      return evaluateLatencyP95(rule);
    default:
      return Promise.reject(new Error(`unknown metric: ${rule.metric}`));
  }
}

/**
 * Evaluate every enabled, non-suppressed rule; insert an alert_firings row
 * (and stamp last_fired_at) for each rule whose condition is met. Returns
 * the number of new firings. Per-rule failures are isolated — one bad rule
 * never blocks the rest.
 */
export async function evaluateRules(): Promise<number> {
  const rules: RuleToEvaluate[] = await sql`
    SELECT id, trigger_type, metric, judge_name, verdicts, threshold_count,
           threshold_value, min_samples, window_minutes, agent_id, account_id
    FROM alert_rules
    WHERE enabled
      AND (last_fired_at IS NULL
           OR last_fired_at <= NOW() - (window_minutes || ' minutes')::interval)
  `;

  let fired = 0;
  for (const rule of rules) {
    try {
      const result =
        rule.trigger_type === "metric_threshold"
          ? await evaluateMetricRule(rule)
          : await evaluateCountRule(rule);
      if (!result.fired) continue;

      const now = new Date();
      const windowStart = new Date(now.getTime() - rule.window_minutes * 60_000);
      let claimed = false;
      await sql.begin(async (tx: typeof sql) => {
        // Stamping last_fired_at doubles as the atomic suppression claim:
        // the conditional UPDATE succeeds for exactly one evaluator per
        // window, so concurrent sweepers can't double-fire a rule.
        const claim = await tx`
          UPDATE alert_rules SET last_fired_at = ${now}, updated_at = NOW()
          WHERE id = ${rule.id}
            AND (last_fired_at IS NULL
                 OR last_fired_at <= NOW() - (window_minutes || ' minutes')::interval)
          RETURNING id
        `;
        if (claim.length === 0) return;
        claimed = true;
        await tx`
          INSERT INTO alert_firings (
            rule_id, window_start, window_end, matched_count, total_count,
            observed_value, sample_session_ids
          ) VALUES (
            ${rule.id}, ${windowStart}, ${now}, ${result.matched_count},
            ${result.total_count}, ${result.observed_value},
            ${result.sample_session_ids ?? []}::jsonb
          )
        `;
      });
      if (!claimed) continue;
      fired++;
      console.log(
        `[alerts] rule fired id=${rule.id} type=${rule.trigger_type}` +
          (rule.metric ? ` metric=${rule.metric}` : "") +
          ` observed=${result.observed_value ?? result.matched_count}`,
      );
    } catch (e) {
      console.error(`[alerts] rule evaluation failed id=${rule.id}: ${(e as Error).message}`);
    }
  }
  return fired;
}
