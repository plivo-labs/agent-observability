import type { NodeEvalInput, NodeEvaluation } from "./types.js";

// Text a model's runtime can leak into a reply. None of it is ever wording a
// customer should receive, so it fails policy in code: a Jev auto-pass never
// reaches the adherence rubric. A raw {{placeholder}} is left to the rubric:
// an agent may be explaining a template.
const RUNTIME_TEXT: readonly RegExp[] = [
  /\bto=functions\.[\w.-]+/i,
  /<\|[a-z][a-z0-9_]*\|>/i,
  /\[\s*tool[ _-]?calls?\b[^\]\n]{0,120}\]/i,
  /<\/?tool_call\b[^>]*>/i,
];

export function visibleRuntimeText(node: NodeEvalInput): string | undefined {
  for (const turn of node.turns) {
    // Only what the agent sent: evidence lines and tool-role messages carry no assistant role.
    if (turn.role !== "assistant" || !turn.agent) continue;
    for (const pattern of RUNTIME_TEXT) {
      const match = pattern.exec(turn.agent);
      if (match) return match[0];
    }
  }
  return undefined;
}

export function failVisibleRuntimeText(evaluation: NodeEvaluation, node: NodeEvalInput): NodeEvaluation {
  const leaked = visibleRuntimeText(node);
  if (!leaked) return evaluation;
  const { confidence: _decidedElsewhere, ...before } = evaluation.instructions_adherence;
  const finding = `The agent's message showed the customer internal runtime text: "${leaked}".`;
  const prior = before.policy_boundary_compliance;
  const policy = prior && !prior.passed
    ? { ...prior, reason: `${finding} ${prior.reason}`.trim() }
    : { passed: false, score: 0, reason_code: "inappropriate_behavior", reason: finding, technical_reason: "runtime text in an agent message" };
  return {
    ...evaluation,
    instructions_adherence: {
      ...before,
      adherence_passed: false,
      // A policy that already failed is already in the score.
      score: prior && !prior.passed ? before.score : Math.max(0, before.score - 0.15 * (prior?.score ?? 1)),
      reason: before.adherence_passed ? `Adherence failed on: policy. Policy: ${finding}` : `${before.reason} Policy: ${finding}`,
      policy_boundary_compliance: policy,
      backend: "code",
    },
  };
}
