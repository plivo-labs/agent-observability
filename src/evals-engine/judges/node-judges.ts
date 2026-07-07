import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import type { ConversationInput, NodeEvalInput } from "../types.js";
import {
  HallucinationRawZ,
  VariableExtractionRawZ,
  NodeLoopRawZ,
  InstructionAdherenceRawZ,
  type HallucinationRaw,
  type VariableExtractionRaw,
  type NodeLoopRaw,
  type InstructionAdherenceRaw,
} from "./types.js";
import {
  systemForHallucination,
  systemForLoop,
  systemForVariableExtraction,
  systemForInstructionAdherence,
} from "./instructions.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { HALLUCINATION_JSON, NODE_LOOP_JSON, VARIABLE_EXTRACTION_JSON, INSTRUCTION_ADHERENCE_JSON } from "./schemas.js";

// AO Eval Engine — the four LLM node judges (per AI node). Each returns its RAW output (Zod-validated);
// mapping to the console contract + the code-derived fields (adherence weighting / passed) is aggregate.ts.
// cx-sqs token caps: instruction 5000, variable 3000, hallucination 1500, loop 1500.

/** Render a node's turns as "User: …\nAgent: …" lines (the node transcript the judges read). */
export function renderNodeTranscript(node: NodeEvalInput): string {
  return node.turns
    .map((t) => {
      const lines: string[] = [];
      if (t.user) lines.push(`User: ${t.user}`);
      if (t.agent) lines.push(`Agent: ${t.agent}`);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

/** Shared user payload for the node judges (superset; each judge reads what it needs, like cx-sqs). */
function nodePayload(node: NodeEvalInput, ctx: ConversationInput): Record<string, unknown> {
  return {
    global_prompt: ctx.global_prompt,
    node_name: node.node_name,
    node_prompt: node.node_prompt,
    available_intents: node.available_intents,
    chosen_intent: node.chosen_intent,
    node_transcript: renderNodeTranscript(node),
    conversation_history: ctx.full_transcript,
  };
}

export async function runHallucinationJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: HallucinationRaw; usage: LlmUsage }> {
  return runLlmJudge({ system: systemForHallucination(), input: nodePayload(node, ctx), schema: HallucinationRawZ, jsonSchema: HALLUCINATION_JSON, maxTokens: 1500, provider });
}

export async function runLoopJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: NodeLoopRaw; usage: LlmUsage }> {
  return runLlmJudge({ system: systemForLoop(), input: nodePayload(node, ctx), schema: NodeLoopRawZ, jsonSchema: NODE_LOOP_JSON, maxTokens: 1500, provider });
}

export async function runVariableExtractionJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: VariableExtractionRaw; usage: LlmUsage }> {
  const expected = node.required_variables.length ? node.required_variables.map((v) => `- ${v}`).join("\n") : "(none)";
  const actualEntries = Object.entries(node.extracted_variables ?? {});
  const actual = actualEntries.length ? actualEntries.map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n") : "(none)";
  return runLlmJudge({
    system: systemForVariableExtraction(expected, actual),
    input: nodePayload(node, ctx),
    schema: VariableExtractionRawZ,
    jsonSchema: VARIABLE_EXTRACTION_JSON,
    maxTokens: 3000,
    provider,
  });
}

export async function runInstructionAdherenceJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: InstructionAdherenceRaw; usage: LlmUsage }> {
  // AO has no per-node scenario "objective", so leave that slot "(none)" (the prompt marks it Optional).
  // Filling it with a copy of the instructions would tell the model objective==instructions — noise.
  return runLlmJudge({
    system: systemForInstructionAdherence(node.node_prompt || "(none)", "(none)"),
    input: nodePayload(node, ctx),
    schema: InstructionAdherenceRawZ,
    jsonSchema: INSTRUCTION_ADHERENCE_JSON,
    maxTokens: 5000,
    provider,
  });
}
