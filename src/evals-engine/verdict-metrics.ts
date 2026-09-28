import { Counter } from "prom-client";
import { metricsRegion, registry } from "../prometheus.js";
import type { ExternalEvalRow } from "./fan-out-rows.js";
import { DEFAULT_JUDGE_ROWS } from "./judge-catalogue.js";
import { SENTIMENT_VALUES } from "./judges/schemas.js";

/** Judges whose fail marks the session as poor quality. voicemail, bot,
 *  call_screening, wrong_number and do_not_disturb describe who answered instead. */
export const QUALITY_JUDGES: ReadonlySet<string> = new Set([
  "hallucination",
  "instructions_adherence",
  "user_never_spoke",
  "low_engagement",
  "intent_identification",
  "variable_extraction",
  "node_loop",
]);

// Custom judges are free-form per-tenant names; label them "other" to bound cardinality.
const KNOWN_JUDGES: ReadonlySet<string> = new Set(DEFAULT_JUDGE_ROWS.map((r) => r.name));
const KNOWN_SENTIMENTS: ReadonlySet<string> = new Set(SENTIMENT_VALUES);

const judgeVerdicts = new Counter({
  name: "ao_judge_verdicts_total",
  help: "Judged sessions per judge and verdict (detection judges: fail = detection fired)",
  labelNames: ["judge", "verdict", "region"] as const,
  registers: [registry],
});
const sessionsJudged = new Counter({
  name: "ao_sessions_judged_total",
  help: "Sessions whose judge verdicts were committed",
  labelNames: ["region"] as const,
  registers: [registry],
});
const sessionsQualityFailed = new Counter({
  name: "ao_sessions_quality_failed_total",
  help: "Judged sessions that failed at least one quality judge",
  labelNames: ["region"] as const,
  registers: [registry],
});
const userSentiment = new Counter({
  name: "ao_user_sentiment_total",
  help: "Judged sessions per user_sentiment value",
  labelNames: ["sentiment", "region"] as const,
  registers: [registry],
});

/** Count one committed session from its fan-out rows. Never throws. */
export function recordJudgedSession(rows: readonly ExternalEvalRow[]): void {
  try {
    const region = metricsRegion;
    // Node judges emit one row per node; the session fails a judge if any node did.
    const failedByJudge = new Map<string, boolean>();
    let sentiment: string | null = null;
    for (const row of rows) {
      // Custom-judge 'unknown' rows are neither pass nor fail.
      if (row.verdictText) continue;
      failedByJudge.set(row.judgeName, (failedByJudge.get(row.judgeName) ?? false) || !row.passed);
      if (row.judgeName === "user_sentiment") sentiment = String(row.raw.sentiment ?? "").toLowerCase();
    }
    let qualityFailed = false;
    for (const [name, failed] of failedByJudge) {
      judgeVerdicts.inc({ judge: KNOWN_JUDGES.has(name) ? name : "other", verdict: failed ? "fail" : "pass", region });
      if (failed && QUALITY_JUDGES.has(name)) qualityFailed = true;
    }
    sessionsJudged.inc({ region });
    if (qualityFailed) sessionsQualityFailed.inc({ region });
    if (sentiment) userSentiment.inc({ sentiment: KNOWN_SENTIMENTS.has(sentiment) ? sentiment : "other", region });
  } catch (e) {
    console.warn(`[prometheus] failed to record judged session: ${(e as Error).message}`);
  }
}
