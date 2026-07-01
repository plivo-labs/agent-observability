import type {
  HallucinationRaw,
  VariableExtractionRaw,
  NodeLoopRaw,
  InstructionAdherenceRaw,
} from "./judges/types.js";
import type {
  HallucinationMetrics,
  VariableExtractionMetrics,
  NodeLoopMetrics,
  InstructionsAdherenceMetrics,
} from "./types.js";

// AO Eval Engine — pure raw→contract mappers + the code-derived fields (never trusted from the LLM).
// The derivations are copied from cx-sqs's node_evaluator.go so AO's numbers match the production engine:
//   * instruction adherence score = .35·objective + .25·procedure + .25·interaction + .15·policy  (clamped 0-1)
//   * adherence_passed = objective.achieved ∧ procedure.passed ∧ policy.passed  (interaction excluded)
//   * procedure.passed = no missed step has severity "critical"
// Cross-node rollups (turn-weighted averages, quality tiers) are NOT emitted — the console derives those
// client-side from node_evaluations[]. The sim `evaluation` payload is the per-node array + goals only.

export const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export function mapHallucination(raw: HallucinationRaw): HallucinationMetrics {
  return { hallucinated: raw.hallucinated, score: clamp01(raw.score), reason: raw.reason, technical_reason: raw.technical_reason };
}

export function mapVariableExtraction(raw: VariableExtractionRaw, requiredVariables: string[]): VariableExtractionMetrics {
  return {
    extraction_successful: raw.extraction_successful,
    score: clamp01(raw.score),
    reason: raw.reason,
    technical_reason: raw.technical_reason,
    // required_variables is authoritative from the node config; missing/incorrect come from the judge.
    required_variables: requiredVariables,
    missing_variables: raw.missing_variables,
    incorrect_variables: raw.incorrect_variables,
  };
}

export function mapNodeLoop(raw: NodeLoopRaw): NodeLoopMetrics {
  return { loop_detected: raw.loop_detected, score: clamp01(raw.score), reason: raw.reason, technical_reason: raw.technical_reason };
}

export function deriveInstructionAdherence(raw: InstructionAdherenceRaw): InstructionsAdherenceMetrics {
  const objective = { ...raw.objective_progress, score: clamp01(raw.objective_progress.score) };
  const procedurePassed = !raw.procedure_compliance.missed_steps.some((s) => s.severity === "critical");
  const procedure = { ...raw.procedure_compliance, passed: procedurePassed, score: clamp01(raw.procedure_compliance.score) };
  const interaction = { ...raw.interaction_quality, score: clamp01(raw.interaction_quality.score) };
  const policy = { ...raw.policy_boundary_compliance, score: clamp01(raw.policy_boundary_compliance.score) };

  const score = clamp01(objective.score * 0.35 + procedure.score * 0.25 + interaction.score * 0.25 + policy.score * 0.15);
  const adherence_passed = objective.achieved && procedure.passed && policy.passed;

  // Top-level reason/technical_reason aren't asked of the LLM; synthesize from the sub-metrics for the UI.
  const failing: string[] = [];
  if (!objective.achieved) failing.push("objective");
  if (!procedure.passed) failing.push("procedure");
  if (!policy.passed) failing.push("policy");
  const reason = adherence_passed
    ? "Instructions followed across objective, procedure, and policy."
    : `Adherence failed on: ${failing.join(", ")}.`;
  const technical_reason = [objective.technical_reason, procedure.technical_reason, interaction.technical_reason, policy.technical_reason]
    .filter(Boolean)
    .join(" | ");

  return {
    adherence_passed,
    score,
    reason,
    technical_reason,
    objective_progress: objective,
    procedure_compliance: procedure,
    interaction_quality: interaction,
    policy_boundary_compliance: policy,
  };
}
