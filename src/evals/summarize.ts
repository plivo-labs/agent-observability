import type { EvalCase } from "./schema.js";

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}

/**
 * Rule: a case counts as `passed` when status==="passed" AND no judgment has
 * verdict==="fail". "maybe" verdicts do not demote a case. `errored` and
 * `skipped` pass through orthogonally.
 */
export function summarize(cases: EvalCase[]): RunSummary {
  const summary: RunSummary = { total: cases.length, passed: 0, failed: 0, errored: 0, skipped: 0 };
  for (const c of cases) {
    if (c.status === "errored") summary.errored++;
    else if (c.status === "skipped") summary.skipped++;
    else if (c.status === "passed" && !(c.judgments ?? []).some((j) => j.verdict === "fail")) summary.passed++;
    else summary.failed++;
  }
  return summary;
}
