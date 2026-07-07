// AO Eval Engine — the two programmatic judges, ported verbatim from the OSS SDK (intent.py / tool.py),
// which themselves port cx-sqs `programmatic.go`. Pure functions, no LLM. UNWIRED for now: the sim path uses
// the LLM intent judge (a sim has no ground-truth expected intent); these are utilities for a future
// test-case / ground-truth eval path.

const norm = (s: string): string => (s ?? "").trim().toLowerCase();

export interface IntentAccuracyResult {
  matched: boolean;
  score: number; // 1.0 on match, 0.0 otherwise
  reason: string;
}

/** Case-insensitive expected-vs-actual intent match (SDK IntentAccuracyJudge). */
export function evaluateIntentAccuracy(args: { expected_intent: string; actual_intent: string }): IntentAccuracyResult {
  const matched = norm(args.expected_intent) === norm(args.actual_intent);
  return {
    matched,
    score: matched ? 1.0 : 0.0,
    reason: matched
      ? `Intent matches. Expected '${args.expected_intent}', got '${args.actual_intent}'.`
      : `Intent mismatch. Expected '${args.expected_intent}', got '${args.actual_intent}'.`,
  };
}

export interface ToolCorrectnessResult {
  passed: boolean;
  score: number;
  matched: string[];
  missing: string[];
  unexpected: string[];
  reason: string;
}

/**
 * Set-membership tool correctness (SDK ToolCorrectnessJudge / programmatic.go:144-152):
 *   both empty → 1.0 · expected non-empty → matched/expected · expected empty & unexpected present → 0.0 · else 1.0
 * passed iff score >= threshold (default 1.0, strict — cx-sqs default).
 */
export function evaluateToolCorrectness(args: {
  expected_tools: Iterable<string>;
  actual_tools: Iterable<string>;
  threshold?: number;
}): ToolCorrectnessResult {
  const threshold = args.threshold ?? 1.0;
  const expected = new Set([...args.expected_tools].filter(Boolean).map(norm));
  const actual = new Set([...args.actual_tools].filter(Boolean).map(norm));

  const matched = [...expected].filter((t) => actual.has(t));
  const missing = [...expected].filter((t) => !actual.has(t));
  const unexpected = [...actual].filter((t) => !expected.has(t));

  let score: number;
  if (expected.size === 0 && actual.size === 0) score = 1.0;
  else if (expected.size > 0) score = matched.length / expected.size;
  else if (unexpected.length > 0) score = 0.0;
  else score = 1.0;

  const passed = score >= threshold;
  const reason = passed
    ? `Tool calls correct. Expected ${expected.size} tool(s), ${matched.length} matched.`
    : [missing.length ? `Missing tools: ${JSON.stringify(missing.sort())}` : "", unexpected.length ? `Unexpected tools: ${JSON.stringify(unexpected.sort())}` : ""]
        .filter(Boolean)
        .join(". ") || "Tool call mismatch.";

  return { passed, score, matched, missing, unexpected, reason };
}
