import { sql } from "../db.js";

// ── Windowed rule evaluation ────────────────────────────────────────────────
//
// Time-driven: the sweeper calls evaluateRules() every tick. Each enabled,
// non-suppressed rule runs one aggregate query over its trailing window.
// Suppression = one firing per window length per rule (last_fired_at).
//
// Events are scoped to a rule's agent/account via a LEFT JOIN to
// agent_transport_sessions — evals/outcomes don't carry agent_id
// themselves. Evals can arrive before their session row exists; windowed
// re-evaluation is self-healing for that race (the next tick sees the
// joined row).

interface RuleToEvaluate {
  id: string;
  trigger_type: string;
  judge_name: string | null;
  verdicts: unknown;
  threshold_count: number | null;
  threshold_pass_rate: number | null;
  min_samples: number;
  window_minutes: number;
  agent_id: string | null;
  account_id: string | null;
}

interface WindowResult {
  matched_count: number;
  total_count: number | null;
  pass_rate: number | null;
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

async function evaluateCountRule(rule: RuleToEvaluate): Promise<WindowResult> {
  const isOutcome = rule.trigger_type === "outcome_count";
  // Verdict containment uses jsonb_exists($x, val) — the function form of
  // the jsonb `?` operator. The operator spelling can't be used here:
  // bun:sql rewrites a literal `?` in query text as a parameter
  // placeholder, silently corrupting the match.
  // Outcomes match against the lk.-prefix-stripped value so rules store
  // normalized success|fail and match both lk.fail and fail.
  const rows = isOutcome
    ? await sql.unsafe(
        `SELECT COUNT(*)::int AS matched,
                (array_agg(DISTINCT o.session_id))[1:20] AS session_ids
         FROM session_outcomes o
         LEFT JOIN agent_transport_sessions s ON s.session_id = o.session_id
         WHERE o.updated_at > NOW() - ($1 || ' minutes')::interval
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
         WHERE e.created_at > NOW() - ($1 || ' minutes')::interval
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
    pass_rate: null,
    sample_session_ids: rows[0]?.session_ids ?? [],
    fired: rule.threshold_count != null && matched >= rule.threshold_count,
  };
}

async function evaluatePassRateRule(rule: RuleToEvaluate): Promise<WindowResult> {
  const rows = await sql.unsafe(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(e.verdict, '')) = 'pass')::int AS passed,
            (array_agg(DISTINCT e.session_id)
               FILTER (WHERE LOWER(COALESCE(e.verdict, '')) <> 'pass'))[1:20] AS session_ids
     FROM session_external_evals e
     LEFT JOIN agent_transport_sessions s ON s.session_id = e.session_id
     WHERE e.created_at > NOW() - ($1 || ' minutes')::interval
       AND ($2::text IS NULL OR e.judge_name = $2)
       AND ($3::text IS NULL OR s.agent_id = $3)
       AND ($4::text IS NULL OR s.account_id = $4)`,
    [String(rule.window_minutes), rule.judge_name, rule.agent_id, rule.account_id],
  );
  const total = rows[0]?.total ?? 0;
  const passed = rows[0]?.passed ?? 0;
  const rate = total > 0 ? passed / total : null;
  return {
    matched_count: total - passed,
    total_count: total,
    pass_rate: rate,
    sample_session_ids: rows[0]?.session_ids ?? [],
    fired:
      rule.threshold_pass_rate != null &&
      total >= rule.min_samples &&
      rate != null &&
      rate < rule.threshold_pass_rate,
  };
}

/**
 * Evaluate every enabled, non-suppressed rule; insert an alert_firings row
 * (and stamp last_fired_at) for each rule whose condition is met. Returns
 * the number of new firings. Per-rule failures are isolated — one bad rule
 * never blocks the rest.
 */
export async function evaluateRules(): Promise<number> {
  const rules: RuleToEvaluate[] = await sql`
    SELECT id, trigger_type, judge_name, verdicts, threshold_count,
           threshold_pass_rate, min_samples, window_minutes, agent_id, account_id
    FROM alert_rules
    WHERE enabled
      AND (last_fired_at IS NULL
           OR last_fired_at <= NOW() - (window_minutes || ' minutes')::interval)
  `;

  let fired = 0;
  for (const rule of rules) {
    try {
      const result =
        rule.trigger_type === "pass_rate"
          ? await evaluatePassRateRule(rule)
          : await evaluateCountRule(rule);
      if (!result.fired) continue;

      const now = new Date();
      const windowStart = new Date(now.getTime() - rule.window_minutes * 60_000);
      let claimed = false;
      await sql.begin(async (tx: any) => {
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
            pass_rate, sample_session_ids
          ) VALUES (
            ${rule.id}, ${windowStart}, ${now}, ${result.matched_count},
            ${result.total_count}, ${result.pass_rate},
            ${result.sample_session_ids ?? []}::jsonb
          )
        `;
      });
      if (!claimed) continue;
      fired++;
      console.log(
        `[alerts] rule fired id=${rule.id} type=${rule.trigger_type} matched=${result.matched_count}` +
          (result.pass_rate != null ? ` pass_rate=${result.pass_rate.toFixed(3)}` : ""),
      );
    } catch (e) {
      console.error(`[alerts] rule evaluation failed id=${rule.id}: ${(e as Error).message}`);
    }
  }
  return fired;
}
