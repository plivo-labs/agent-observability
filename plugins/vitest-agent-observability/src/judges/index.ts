/**
 * Public API for the judges module.
 *
 * Sync target:
 *   plugins/pytest-agent-observability/src/pytest_agent_observability/judges/__init__.py
 */

export type { Rubric } from "./rubrics.js";
export { HALLUCINATION_RUBRIC, ADHERENCE_RUBRIC } from "./rubrics.js";
export type { JudgeInput, LLMClient, CriterionResult } from "./runner.js";
export { openaiAdapter } from "./adapters/openai.js";

import { HALLUCINATION_RUBRIC, ADHERENCE_RUBRIC } from "./rubrics.js";
import type { Rubric } from "./rubrics.js";
import { evaluate as _evaluate } from "./runner.js";
import type { JudgeInput, LLMClient, CriterionResult } from "./runner.js";

const RUBRIC_MAP: Record<string, Rubric> = {
  hallucination: HALLUCINATION_RUBRIC,
  adherence: ADHERENCE_RUBRIC,
};

export const judges = {
  async hallucination(
    input: JudgeInput,
    llm: LLMClient,
    opts?: { threshold?: number },
  ): Promise<CriterionResult | undefined> {
    const results = await _evaluate({
      rubrics: [HALLUCINATION_RUBRIC],
      input,
      llm,
      threshold: opts?.threshold,
    });
    return results["hallucination"];
  },

  async adherence(
    input: JudgeInput,
    llm: LLMClient,
    opts?: { threshold?: number },
  ): Promise<CriterionResult | undefined> {
    const results = await _evaluate({
      rubrics: [ADHERENCE_RUBRIC],
      input,
      llm,
      threshold: opts?.threshold,
    });
    return results["adherence"];
  },

  async evaluate({
    criteria = ["hallucination", "adherence"],
    input,
    llm,
    threshold,
  }: {
    criteria?: ("hallucination" | "adherence")[];
    input: JudgeInput;
    llm: LLMClient;
    threshold?: number;
  }): Promise<Record<string, CriterionResult>> {
    const rubrics = criteria
      .map((c) => RUBRIC_MAP[c])
      .filter((r): r is Rubric => r !== undefined);
    return _evaluate({ rubrics, input, llm, threshold });
  },

  async custom({
    rubric,
    input,
    llm,
    threshold,
  }: {
    rubric: Rubric;
    input: JudgeInput;
    llm: LLMClient;
    threshold?: number;
  }): Promise<CriterionResult | undefined> {
    const results = await _evaluate({ rubrics: [rubric], input, llm, threshold });
    return results[rubric.name];
  },
};
