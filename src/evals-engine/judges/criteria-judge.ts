import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import type { ConversationInput, CriterionResult } from "../types.js";
import { CriteriaRawZ } from "./types.js";
import { systemForCriteria } from "./instructions.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { CRITERIA_JSON } from "./schemas.js";

// AO Eval Engine — scenario acceptance-criteria judge (one LLM call for all criteria). Modelled on
// goal-judge.ts and run through runLlmJudge so it shares the global judge semaphore. Ported from the
// Hunter harness criteria evaluator: each criterion scored independently 0-1, evidence-or-zero, a
// conditional criterion whose precondition never fired is applicable:false and excluded, and the
// verdict is the min() over applicable criteria. A parse failure throws (→ eval_error upstream),
// exactly like the other judges.

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * min()-aggregate over the applicable criteria (Hunter `_compute_criteria_score`):
 *   - some applicable → the minimum accuracy (one bad criterion tanks it),
 *   - criteria existed but every one is N/A → 1.0 (nothing applicable was violated),
 *   - empty verdict → 0.0 (the model returned no criteria — a fail, not a pass).
 */
export function aggregateCriteriaScore(criteria: CriterionResult[]): number {
  const applicable = criteria.filter((c) => c.applicable !== false);
  if (applicable.length > 0) return Math.min(...applicable.map((c) => c.accuracy_score ?? 0));
  if (criteria.length > 0) return 1.0;
  return 0.0;
}

/**
 * Score a scenario's acceptance criteria against the run transcript. Returns the per-criterion
 * results plus the min()-aggregated score. `accuracy_score` is nulled for N/A criteria and, for
 * applicable ones, forced to 0 when the model quoted no evidence (the quote-or-zero rule, enforced
 * in code so it holds regardless of what the model self-scored).
 */
export async function runCriteriaJudge(
  criteria: string[],
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: { criteria: CriterionResult[]; score: number }; usage: LlmUsage }> {
  const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const flowHistory = ctx.full_transcript || "(no transcript)";

  const res = await runLlmJudge({
    system: systemForCriteria(criteriaText, flowHistory),
    input: { flow_name: ctx.flow_name, criteria: criteria.map((c, i) => ({ id: i + 1, description: c })) },
    schema: CriteriaRawZ,
    jsonSchema: CRITERIA_JSON,
    maxTokens: 2000,
    provider,
  });

  const scored: CriterionResult[] = res.data.criteria.map((c) => {
    const applicable = c.applicable !== false;
    const hasEvidence = typeof c.evidence === "string" && c.evidence.trim() !== "";
    return {
      id: c.id,
      description: c.description,
      applicable,
      met: applicable ? Boolean(c.met) : null,
      // Quote-or-zero: an applicable criterion with no quoted evidence scores 0 regardless of the
      // model's self-reported accuracy.
      accuracy_score: applicable ? (hasEvidence ? clamp01(c.accuracy_score ?? 0) : 0) : null,
      evidence: c.evidence,
    };
  });

  return { data: { criteria: scored, score: aggregateCriteriaScore(scored) }, usage: res.usage };
}
