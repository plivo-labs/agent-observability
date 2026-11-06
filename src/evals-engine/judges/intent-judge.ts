import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import type { ConversationInput, NodeEvalInput, IntentIdentificationMetrics } from "../types.js";
import { IntentIdentificationRawZ } from "./types.js";
import { systemForIntent } from "./instructions.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { scopedNodeEvidence } from "../node-evidence.js";
import { INTENT_JSON } from "./schemas.js";

// AO Eval Engine — intent identification judge. LLM-based, matching the reference engine's MetricIntent: given the node's
// available intents + the intent the agent chose + the conversation, the model returns `intent_not_found`
// and `intent_wrongly_identified`; the SCORE is code-derived = 1.0 iff neither flag is set (the reference engine
// post-processing). A simulation has no ground-truth "expected" intent, so this is a judgment
// call, not a string compare — hence LLM, not programmatic. reference-engine token cap for intent: 1500.

function renderIntents(available: unknown[]): string {
  if (!available.length) return "(none)";
  return available
    .map((i) => {
      if (i && typeof i === "object") {
        const o = i as Record<string, unknown>;
        const name = o.intent_name ?? o.id ?? "";
        const instr = o.intent_instructions ? `: ${o.intent_instructions}` : "";
        return `- ${String(name)}${instr}`;
      }
      return `- ${String(i)}`;
    })
    .join("\n");
}

export async function runIntentJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: IntentIdentificationMetrics; usage: LlmUsage }> {
  // No intents configured on the node → there is nothing to identify against;
  // running the judge would force intent_not_found=true for every valid user
  // request (rule 1 has an empty list to match). Neutral pass, no LLM call.
  if (!Array.isArray(node.available_intents) || node.available_intents.length === 0) {
    return {
      data: {
        intent_not_found: false,
        intent_wrongly_identified: false,
        score: 1.0,
        reason: "No intents configured on this node — intent identification not applicable.",
        technical_reason: "skipped: empty available_intents",
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  const res = await runLlmJudge({
    system: systemForIntent(renderIntents(node.available_intents), node.chosen_intent || "(none)"),
    input: {
      global_prompt: ctx.global_prompt,
      node_name: node.node_name,
      chosen_intent: node.chosen_intent,
      ...scopedNodeEvidence(node, ctx),
    },
    schema: IntentIdentificationRawZ,
    jsonSchema: INTENT_JSON,
    maxTokens: 1500,
    provider,
  });
  const raw = res.data;
  // A wrong selection outranks not-found so a contradicting choice is never
  // read as a catalogue gap. A gap also needs the node to have routed nowhere:
  // selecting or handing off outside the list is the agent's own error.
  const wrong = raw.intent_wrongly_identified;
  const notFound = raw.intent_not_found && !wrong;
  const gap = notFound && raw.reason_code === "catalogue_gap" && !node.chosen_intent && !node.handed_off;
  const data: IntentIdentificationMetrics = {
    intent_not_found: notFound,
    intent_wrongly_identified: wrong,
    score: notFound || wrong ? 0.0 : 1.0,
    reason_code: wrong ? "wrong_intent" : !notFound ? "no_defect" : gap ? "catalogue_gap" : "unlisted_intent",
    reason: raw.reason,
    technical_reason: raw.technical_reason,
  };
  return { data, usage: res.usage };
}
