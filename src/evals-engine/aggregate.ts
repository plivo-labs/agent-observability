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
  NodeEvalInput,
} from "./types.js";
import { IDLE_TAG } from "./types.js";

// AO Eval Engine — pure raw→contract mappers + the code-derived fields (never trusted from the LLM).
// The derivations are copied from the reference engine so AO's numbers match the validated implementation:
//   * instruction adherence score = .35·objective + .25·procedure + .25·interaction + .15·policy  (clamped 0-1)
//   * adherence_passed = objective.achieved ∧ procedure.passed ∧ policy.passed  (interaction excluded)
//   * procedure.passed = no missed step has severity "critical"
//   * verdict "unknown" = policy is the only failing part and its agent_quote is not in this node's agent turns
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

// Each of these names something the agent said, so the fail must quote it; a
// handoff_violation's evidence is a tool call or its absence, with no words to quote.
const QUOTED_POLICY_CODES = new Set(["out_of_scope_no_deferral", "confidentiality_violation", "inappropriate_behavior", "other_boundary_violation"]);
// Below this a filler phrase ("okay, sure") would match some turn by chance.
const MIN_QUOTE_CHARS = 12;

// A number keeps its sign and inner separators so "100.00" and "-5" stay
// distinct from "10000" and "5"; any other punctuation only separates words.
const SPEECH_TOKEN = /(?:(?<![\p{L}\p{M}\p{N}])[+-])?\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}\p{N}]+/gu;
const NUMBER_EDGE = /[\p{N}.,+-]/u;

/** Survives case, punctuation and spacing drift; turn tags are not speech.
 *  Upper-then-lower folds "ß" to "ss" as full case folding does. */
function speechKey(text: string): string {
  const folded = text.normalize("NFKC").replaceAll("\u2212", "-").toUpperCase().toLowerCase();
  return [...folded.replaceAll(IDLE_TAG, " ").replaceAll("[interrupted]", " ").matchAll(SPEECH_TOKEN)].map((m) => m[0]).join(" ");
}

/** Unbounded so a quote can sit inside an unspaced script, except that a
 *  number at either end of the quote may not continue a longer number. */
function containsQuote(turn: string, quote: string): boolean {
  const opensWithNumber = /^[+-]?\p{N}/u.test(quote);
  const closesWithNumber = /\p{N}$/u.test(quote);
  for (let i = turn.indexOf(quote); i !== -1; i = turn.indexOf(quote, i + 1)) {
    const extendsBefore = opensWithNumber && NUMBER_EDGE.test(turn[i - 1] ?? "");
    const extendsAfter = closesWithNumber && NUMBER_EDGE.test(turn[i + quote.length] ?? "");
    if (!extendsBefore && !extendsAfter) return true;
  }
  return false;
}

function unverifiedPolicyFail(policy: InstructionAdherenceRaw["policy_boundary_compliance"], node: Pick<NodeEvalInput, "turns">): string | null {
  if (policy.passed) return null;
  const code = policy.reason_code.trim().toLowerCase();
  if (!QUOTED_POLICY_CODES.has(code)) return null;
  const quote = speechKey(policy.agent_quote);
  if (!quote) return `no agent_quote for ${code}`;
  if ([...quote.replaceAll(" ", "")].length < MIN_QUOTE_CHARS) return `agent_quote "${policy.agent_quote}" is under ${MIN_QUOTE_CHARS} characters`;
  const said = node.turns.some((t) => !t.evidence && !!t.agent && containsQuote(speechKey(t.agent), quote));
  return said ? null : `agent_quote "${policy.agent_quote}" is not in this node's agent turns`;
}

export function deriveInstructionAdherence(raw: InstructionAdherenceRaw, node: Pick<NodeEvalInput, "turns">): InstructionsAdherenceMetrics {
  const objective = { ...raw.objective_progress, score: clamp01(raw.objective_progress.score) };
  // Case-insensitive: a model emitting "Critical" must not silently convert a
  // failed procedure into a pass.
  const procedurePassed = !raw.procedure_compliance.missed_steps.some((s) => (s.severity ?? "").toLowerCase() === "critical");
  const procedure = { ...raw.procedure_compliance, passed: procedurePassed, score: clamp01(raw.procedure_compliance.score) };
  const interaction = { ...raw.interaction_quality, score: clamp01(raw.interaction_quality.score) };
  const policy = { ...raw.policy_boundary_compliance, score: clamp01(raw.policy_boundary_compliance.score) };
  const unverified = unverifiedPolicyFail(raw.policy_boundary_compliance, node);

  const score = clamp01(objective.score * 0.35 + procedure.score * 0.25 + interaction.score * 0.25 + policy.score * 0.15);
  const adherence_passed = objective.achieved && procedure.passed && policy.passed;
  const unknown = unverified !== null && objective.achieved && procedure.passed;

  // Top-level reason/technical_reason aren't asked of the LLM; synthesize from
  // the sub-metrics for the UI. Include each failing rubric's own reason (and
  // procedure's missed steps) — a bare "failed on: procedure" gives the reader
  // nothing to act on even though the judge explained itself in detail.
  const failing: Array<{ part: string; detail: string }> = [];
  if (!objective.achieved) failing.push({ part: "objective", detail: objective.reason });
  if (!procedure.passed) {
    const missed = raw.procedure_compliance.missed_steps
      .filter((s) => (s.severity ?? "").toLowerCase() === "critical")
      .map((s) => s.step || s.details)
      .filter(Boolean)
      .join("; ");
    const detail = [procedure.reason, missed ? `Missed: ${missed}` : ""].filter(Boolean).join(" ");
    failing.push({ part: "procedure", detail });
  }
  if (!policy.passed && !unverified) failing.push({ part: "policy", detail: policy.reason });
  const cap = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
  const reason = adherence_passed
    ? "Instructions followed across objective, procedure, and policy."
    : unknown
      ? `Adherence unverified: the policy finding does not quote anything the agent said in this node.${policy.reason ? ` Policy: ${policy.reason}` : ""}`
      : `Adherence failed on: ${failing.map((f) => f.part).join(", ")}.${failing
          .filter((f) => f.detail)
          .map((f) => ` ${cap(f.part)}: ${f.detail}`)
          .join("")}`;
  const technical_reason = [
    unverified ? `policy fail unverified: ${unverified}` : "",
    objective.technical_reason, procedure.technical_reason, interaction.technical_reason, policy.technical_reason,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    adherence_passed,
    ...(unknown ? { verdict: "unknown" as const } : {}),
    score,
    reason,
    technical_reason,
    objective_progress: objective,
    procedure_compliance: procedure,
    interaction_quality: interaction,
    policy_boundary_compliance: policy,
    config_conflicts: raw.config_conflicts ?? [],
  };
}
