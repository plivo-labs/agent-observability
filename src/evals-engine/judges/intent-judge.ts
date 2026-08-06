import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import type { ConversationInput, NodeEvalInput, IntentIdentificationMetrics } from "../types.js";
import { IntentIdentificationRawZ } from "./types.js";
import { systemForIntent } from "./instructions.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { renderNodeTranscript } from "./node-judge-payload.js";
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
      node_transcript: renderNodeTranscript(node),
      conversation_history: ctx.full_transcript,
    },
    schema: IntentIdentificationRawZ,
    jsonSchema: INTENT_JSON,
    maxTokens: 1500,
    provider,
  });
  const raw = res.data;
  // Deterministic enforcement of the prompt's rule 2: an EMPTY chosen intent
  // means the framework recorded nothing — that can never be a WRONG
  // identification (there is no identification to be wrong). Models violate
  // this rule under ambiguity (8/188 confirmed prod FPs, Aug-6 audit), so the
  // rule lives in code, same pattern as the loop judge's idle strip.
  let wrong = raw.intent_wrongly_identified;
  let technical = raw.technical_reason;
  if (wrong && !node.chosen_intent?.trim()) {
    wrong = false;
    technical = `guarded: no intent was recorded (empty chosen intent), so intent_wrongly_identified cannot apply. Original verdict: ${raw.technical_reason}`;
  }
  const correct = !raw.intent_not_found && !wrong;
  const data: IntentIdentificationMetrics = {
    intent_not_found: raw.intent_not_found,
    intent_wrongly_identified: wrong,
    score: correct ? 1.0 : 0.0,
    reason: raw.reason,
    technical_reason: technical,
  };
  return { data, usage: res.usage };
}
