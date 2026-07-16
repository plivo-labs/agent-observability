import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import { IDLE_TAG } from "../types.js";
import type { ConversationInput, NodeEvalInput } from "../types.js";
import {
  HallucinationRawZ,
  NodeLoopRawZ,
  InstructionAdherenceRawZ,
  type HallucinationRaw,
  type NodeLoopRaw,
  type InstructionAdherenceRaw,
} from "./types.js";
import {
  systemForHallucination,
  systemForLoop,
  systemForInstructionAdherence,
} from "./instructions.js";
import { nodePayload } from "./node-judge-payload.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { HALLUCINATION_JSON, NODE_LOOP_JSON, INSTRUCTION_ADHERENCE_JSON } from "./schemas.js";

export { renderNodeTranscript } from "./node-judge-payload.js";
export { runVariableExtractionJudge } from "./variable-extraction.js";

// AO Eval Engine — the four LLM node judges (per AI node). Each returns its RAW output (Zod-validated);
// mapping to the console contract + the code-derived fields (adherence weighting / passed) is aggregate.ts.
// reference-engine token caps: instruction 5000, variable 3000, hallucination 1500, loop 1500.

export async function runHallucinationJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: HallucinationRaw; usage: LlmUsage }> {
  return runLlmJudge({ system: systemForHallucination(), input: nodePayload(node, ctx), schema: HallucinationRawZ, jsonSchema: HALLUCINATION_JSON, maxTokens: 1500, provider });
}

/** Strip platform idle re-prompts from the loop judge's view. Models do NOT
 *  reliably honor a written "exclude tagged turns" rule (verified live: the
 *  judge names them idle prompts and still fires), so the exclusion is done
 *  here deterministically — the same way the legacy engine strips marked idle
 *  turns before loop analysis. Filters on the structured EvalTurn.idle flag
 *  (same pattern as `evidence`), never on turn text. Only the loop judge gets
 *  the filtered view; the other judges keep tagged turns as context. */
export function withoutIdleTurns(node: NodeEvalInput): NodeEvalInput {
  const turns = node.turns.filter((t) => !t.idle);
  return turns.length === node.turns.length ? node : { ...node, turns, turn_count: turns.length };
}

/** The loop judge's conversation_history with idle lines removed. The rendered
 *  string is session-wide and identical for every node, while runLoopJudge
 *  runs once per node — memoize per ConversationInput so the strip is O(1)
 *  after the first node. (Line-level filtering matches renderFullTranscript's
 *  one-line-per-role output; the IDLE_TAG suffix sits on the tagged line.) */
const idleFreeTranscriptCache = new WeakMap<ConversationInput, string>();
function idleFreeTranscript(ctx: ConversationInput): string {
  if (!ctx.full_transcript.includes(IDLE_TAG)) return ctx.full_transcript;
  let cached = idleFreeTranscriptCache.get(ctx);
  if (cached === undefined) {
    cached = ctx.full_transcript.split("\n").filter((l) => !l.includes(IDLE_TAG)).join("\n");
    idleFreeTranscriptCache.set(ctx, cached);
  }
  return cached;
}

export async function runLoopJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: NodeLoopRaw; usage: LlmUsage }> {
  const loopNode = withoutIdleTurns(node);
  const stripped = idleFreeTranscript(ctx);
  const loopCtx: ConversationInput = stripped === ctx.full_transcript ? ctx : { ...ctx, full_transcript: stripped };
  return runLlmJudge({ system: systemForLoop(), input: nodePayload(loopNode, loopCtx), schema: NodeLoopRawZ, jsonSchema: NODE_LOOP_JSON, maxTokens: 1500, provider });
}

export async function runInstructionAdherenceJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: InstructionAdherenceRaw; usage: LlmUsage }> {
  // No instructions configured → there is nothing to adhere to. Judging
  // against "(none)" makes the model invent an objective and often fail it —
  // a false adherence fail on routing/greeting nodes. Neutral pass, no LLM
  // call (same pattern as the intent judge's empty-intents skip).
  if (!node.node_prompt || !node.node_prompt.trim()) {
    const sub = (reason: string) => ({ score: 1.0, reason_code: "not_applicable", reason, technical_reason: "skipped: node has no instructions" });
    return {
      data: {
        objective_progress: { achieved: true, ...sub("No instructions configured on this node — adherence not applicable.") },
        procedure_compliance: { ...sub("No procedure defined."), missed_steps: [] },
        interaction_quality: { ...sub("Not evaluated."), issues: [] },
        policy_boundary_compliance: { passed: true, ...sub("No policy boundaries defined.") },
      } as InstructionAdherenceRaw,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  // AO has no per-node scenario "objective", so leave that slot "(none)" (the prompt marks it Optional).
  // Filling it with a copy of the instructions would tell the model objective==instructions — noise.
  return runLlmJudge({
    system: systemForInstructionAdherence(node.node_prompt, "(none)"),
    input: nodePayload(node, ctx),
    schema: InstructionAdherenceRawZ,
    jsonSchema: INSTRUCTION_ADHERENCE_JSON,
    maxTokens: 5000,
    provider,
  });
}
