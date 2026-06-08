import type { EvalCase } from "./schema.js";

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}

/**
 * Rule: a case counts as `passed` when status==="passed" AND no GATING judgment
 * has verdict==="fail". A gating judgment is a per-criterion verdict (pytest/
 * vitest: `{intent, verdict}`). Leveled-judge **scope rows** (sim runs:
 * `{scope: "flow"|"agent:…"|"task:…"|"node:…", verdict}`) are DIAGNOSTIC, not
 * gating — a single failing node must NOT demote a case the producer already
 * scored as passed (score ≥ threshold). Demoting on them previously zeroed the
 * pass rate of fully-passing leveled sim runs. "maybe" verdicts don't demote;
 * `errored`/`skipped` pass through orthogonally.
 */
export function summarize(cases: EvalCase[]): RunSummary {
  const summary: RunSummary = { total: cases.length, passed: 0, failed: 0, errored: 0, skipped: 0 };
  for (const c of cases) {
    if (c.status === "errored") summary.errored++;
    else if (c.status === "skipped") summary.skipped++;
    else if (
      c.status === "passed" &&
      !(c.judgments ?? []).some((j) => j.verdict === "fail" && !(j as { scope?: unknown }).scope)
    ) summary.passed++;
    else summary.failed++;
  }
  return summary;
}
