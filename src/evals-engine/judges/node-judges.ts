import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import { renderFullTranscript } from "../conversation-input.js";
import { IDLE_TAG } from "../types.js";
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
// reference-engine token caps: instruction 5000, variable 3000, hallucination 1500, loop 1500.

/** Render the node transcript with the shared conversation evidence rules. */
export function renderNodeTranscript(node: NodeEvalInput): string {
  return renderFullTranscript(node.turns);
}

/** Shared user payload for the node judges (superset; each judge reads what it needs, like the reference engine).
 *  Grounding evidence (extracted_variables / global_variables / pronunciation_guides) is included when present so
 *  the hallucination judge can trace claims to it — a value the runtime supplied must not read as fabricated.
 *  Empty maps are omitted to keep the payload clean. */
function nodePayload(node: NodeEvalInput, ctx: ConversationInput): Record<string, unknown> {
  const hasEntries = (m: Record<string, unknown> | undefined): m is Record<string, unknown> => !!m && Object.keys(m).length > 0;
  return {
    global_prompt: ctx.global_prompt,
    node_name: node.node_name,
    node_prompt: node.node_prompt,
    available_intents: node.available_intents,
    chosen_intent: node.chosen_intent,
    node_transcript: renderNodeTranscript(node),
    conversation_history: ctx.full_transcript,
    ...(hasEntries(node.extracted_variables) ? { extracted_variables: node.extracted_variables } : {}),
    ...(hasEntries(ctx.global_variables) ? { global_variables: ctx.global_variables } : {}),
    ...(hasEntries(ctx.pronunciation_guides) ? { pronunciation_guides: ctx.pronunciation_guides } : {}),
  };
}

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

export async function runVariableExtractionJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: VariableExtractionRaw; usage: LlmUsage }> {
  // No variables configured and none extracted → nothing to judge; a neutral
  // pass avoids the model speculating about variables that don't exist.
  if (node.required_variables.length === 0 && Object.keys(node.extracted_variables ?? {}).length === 0) {
    return {
      data: {
        extraction_successful: true,
        score: 1.0,
        reason: "No variables configured on this node — extraction not applicable.",
        technical_reason: "skipped: empty required_variables and extracted_variables",
        missing_variables: [],
        incorrect_variables: [],
      } as VariableExtractionRaw,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  // Render each variable with its recording rule so conditional rules
  // ("leave empty unless the caller confirms…") are judged against, not
  // guessed at — prompt step 5 depends on the rule being visible here.
  const expected = node.required_variables.length
    ? node.required_variables
        .map((v) => {
          const rule = node.variable_rules?.[v];
          return rule ? `- ${v} — recording rule: ${rule}` : `- ${v}`;
        })
        .join("\n")
    : "(none)";
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
