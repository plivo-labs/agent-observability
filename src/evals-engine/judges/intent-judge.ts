import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import type { ConversationInput, NodeEvalInput, IntentIdentificationMetrics } from "../types.js";
import { IntentIdentificationRawZ } from "./types.js";
import { systemForIntent } from "./instructions.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { renderNodeTranscript } from "./node-judges.js";
import { INTENT_JSON } from "./schemas.js";

// AO Eval Engine — intent identification judge. LLM-based, matching cx-sqs's MetricIntent: given the node's
// available intents + the intent the agent chose + the conversation, the model returns `intent_not_found`
// and `intent_wrongly_identified`; the SCORE is code-derived = 1.0 iff neither flag is set (cx-sqs
// node_evaluator.go postProcess). A simulation has no ground-truth "expected" intent, so this is a judgment
// call, not a string compare — hence LLM, not programmatic. cx-sqs token cap for intent: 1500.

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
  const res = await runLlmJudge({
    system: systemForIntent(renderIntents(node.available_intents), node.chosen_intent || "(none)"),
    input: {
      global_prompt: ctx.global_prompt,
      node_name: node.node_name,
      chosen_intent: node.chosen_intent,
      node_transcript: renderNodeTranscript(node),
      conversation_history: ctx.full_transcript,
    },
    schema: IntentIdentificationRawZ,
    jsonSchema: INTENT_JSON,
    maxTokens: 1500,
    provider,
  });
  const raw = res.data;
  const correct = !raw.intent_not_found && !raw.intent_wrongly_identified;
  const data: IntentIdentificationMetrics = {
    intent_not_found: raw.intent_not_found,
    intent_wrongly_identified: raw.intent_wrongly_identified,
    score: correct ? 1.0 : 0.0,
    reason: raw.reason,
    technical_reason: raw.technical_reason,
  };
  return { data, usage: res.usage };
}
