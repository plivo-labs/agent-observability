import type { ConversationInput, NodeEvalInput, NodeEvaluation } from "./types.js";

// Text a model's runtime can leak into a reply. None of it is ever wording a
// customer should receive, so it fails policy in code: a Jev auto-pass never
// reaches the adherence rubric. A raw {{placeholder}} is left to the rubric:
// an agent may be explaining a template, and so is a Markdown link label
// such as [tool calls](url).
const RUNTIME_TEXT: readonly RegExp[] = [
  /\bto=functions\.[\w.-]+/i,
  /<\|[a-z][a-z0-9_]*\|>/i,
  /\[\s*tool[ _-]?calls?\b[^\]\n]{0,120}\](?!\()/i,
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

// Scripts a decoder can emit as stray tokens mid-reply ("】【。", "конс?", spam
// phrases). CJK punctuation counts as Han: it is how the glitch usually shows.
const STRAY_SCRIPTS: readonly RegExp[] = [
  /[\p{Script=Han}\u3000-\u303f\uff01-\uff60]/u,
  /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Georgian}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Bengali}/u,
  /\p{Script=Gurmukhi}/u,
  /\p{Script=Gujarati}/u,
  /\p{Script=Tamil}/u,
  /\p{Script=Telugu}/u,
  /\p{Script=Kannada}/u,
  /\p{Script=Malayalam}/u,
];
// Below this many characters across all of the agent's replies, a script is a
// fragment rather than a language the agent is speaking.
const SPOKEN_SCRIPT_MIN_CHARS = 20;

const count = (text: string, script: RegExp) => text.match(new RegExp(script.source, "gu"))?.length ?? 0;

/** A fragment in a script the conversation never uses: not in the instructions,
 *  anything the customer wrote, any tool result, nor spoken at length by the
 *  agent. A conversation held in that language is never flagged. */
export function strayScriptText(node: NodeEvalInput, conversation: ConversationInput): string | undefined {
  const turns = conversation.timeline ?? conversation.nodes.flatMap((n) => n.turns);
  const spoken = turns.filter((t) => t.role === "assistant" && !t.evidence).map((t) => t.agent).join("\n");
  const established = [
    conversation.global_prompt,
    ...conversation.nodes.map((n) => n.node_prompt),
    ...turns.map((t) => t.user),
    ...turns.filter((t) => t.evidence || t.role !== "assistant").map((t) => t.agent),
  ].join("\n");
  for (const turn of node.turns) {
    if (turn.role !== "assistant" || turn.evidence || !turn.agent) continue;
    for (const script of STRAY_SCRIPTS) {
      const at = turn.agent.search(script);
      if (at < 0 || script.test(established) || count(spoken, script) >= SPOKEN_SCRIPT_MIN_CHARS) continue;
      return turn.agent.slice(Math.max(0, at - 20), at + 20).trim();
    }
  }
  return undefined;
}

export function failVisibleRuntimeText(evaluation: NodeEvaluation, node: NodeEvalInput, conversation?: ConversationInput): NodeEvaluation {
  const runtime = visibleRuntimeText(node);
  const stray = runtime ? undefined : conversation && strayScriptText(node, conversation);
  if (!runtime && !stray) return evaluation;
  const { confidence: _decidedElsewhere, ...before } = evaluation.instructions_adherence;
  const finding = runtime
    ? `The agent's message showed the customer internal runtime text: "${runtime}".`
    : `The agent's message showed the customer stray text in a script this conversation never uses: "${stray}".`;
  const prior = before.policy_boundary_compliance;
  const policy = prior && !prior.passed
    ? { ...prior, reason: `${finding} ${prior.reason}`.trim() }
    : { passed: false, score: 0, reason_code: "inappropriate_behavior", reason: finding, technical_reason: runtime ? "runtime text in an agent message" : "stray-script text in an agent message" };
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
