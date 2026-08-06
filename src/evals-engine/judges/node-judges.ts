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
import { nodePayload, adherenceNodePayload, renderNodeTranscript } from "./node-judge-payload.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { HALLUCINATION_JSON, NODE_LOOP_JSON, INSTRUCTION_ADHERENCE_JSON } from "./schemas.js";

// AO Eval Engine — the four LLM node judges (per AI node). Each returns its RAW output (Zod-validated);
// mapping to the console contract + the code-derived fields (adherence weighting / passed) is aggregate.ts.
// reference-engine token caps: instruction 5000, variable 3000, hallucination 1500, loop 1500.

export async function runHallucinationJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: HallucinationRaw; usage: LlmUsage }> {
  // A node ref the config doesn't know (a segment the sender never exported —
  // e.g. a screening step — or a config snapshot gap) arrives with an empty
  // prompt. With no configured instruction surface at all (node AND global),
  // the judge is missing evidence source 3 entirely and reads the agent's own
  // configured identity/campaign facts ("Maya from BrightSmile Dental") as
  // fabricated — 10/13 dev screening calls false-fired this way (2026-08-04).
  // Neutral pass, no LLM call — same pattern as the adherence judge's
  // no-instructions skip. A non-empty global_prompt keeps the judge running:
  // that is a real grounding surface, and contradictions with conversation or
  // tool evidence are still detectable against it.
  if (!node.node_prompt?.trim() && !ctx.global_prompt?.trim()) {
    return {
      data: {
        hallucinated: false,
        score: 1.0,
        reason: "Node configuration was not captured for this segment — grounding cannot be assessed.",
        technical_reason:
          "skipped: node_prompt and global_prompt are both empty; the configured-instructions grounding surface is missing, so unsupported-claim verdicts would be unreliable",
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  const res = await runLlmJudge({ system: systemForHallucination(), input: nodePayload(node, ctx), schema: HallucinationRawZ, jsonSchema: HALLUCINATION_JSON, maxTokens: 1500, provider });
  return { ...res, data: withoutOutOfSegmentFire(withoutToolArgFire(res.data, node), node, ctx) };
}

/** Lowercase, straighten typographic quotes, collapse whitespace — so a claim
 *  the judge quoted can be located in a rendered transcript despite quote-style
 *  and spacing drift. */
function normalizeForMatch(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Quoted spans from a technical_reason — the `Unsupported spoken claim: "…"`
 *  format the prompt mandates (straight or typographic quotes). */
function quotedClaims(technicalReason: string): string[] {
  const out: string[] = [];
  for (const m of technicalReason.matchAll(/"([^"]+)"|“([^“”]+)”/g)) {
    const claim = normalizeForMatch(m[1] ?? m[2] ?? "");
    // Short spans ("Koramangala") can't be located reliably and legitimately
    // recur across segments — only full quoted utterance fragments count.
    if (claim.length >= 20) out.push(claim);
  }
  return out;
}

/** Deterministic backstop for the SEGMENT SCOPE prompt rule (models don't
 *  reliably honor exclusion prose — same lesson as withoutIdleTurns below).
 *  A hallucination fire whose every quoted claim is absent from this node's
 *  own transcript but present elsewhere in the conversation charged a line
 *  spoken in ANOTHER node's segment — where the owning node's evaluation
 *  judges it against the right instructions (verified live on dev session
 *  87a57b09: the screening judge flagged the main node's grounded
 *  "appointment in BrightSmile Dental, Koramangala" line). Neutralize it,
 *  keeping the original verdict in technical_reason for audit. A claim found
 *  NOWHERE (paraphrased quote) leaves the verdict untouched — the backstop
 *  only acts when the out-of-segment origin is provable. */
/** Deterministic backstop for prompt rules 8/36 (Tool_Call:/Tool_Result:/
 *  System_Note: lines are never accusation targets). The dominant confirmed
 *  prod FP class (Aug-6 audit) is the judge charging a silent record_* payload
 *  as a spoken claim. A fire whose every quoted claim is absent from the
 *  node's SPOKEN lines but present in its tool/runtime-event lines is
 *  neutralized, preserving the original verdict for audit. Claims found in
 *  neither (paraphrase) are left untouched — the backstop only acts when the
 *  internal-line origin is provable. */
export function withoutToolArgFire(data: HallucinationRaw, node: NodeEvalInput): HallucinationRaw {
  if (!data.hallucinated) return data;
  const claims = quotedClaims(data.technical_reason);
  if (claims.length === 0) return data;
  const lines = renderNodeTranscript(node).split("\n");
  const spoken = normalizeForMatch(lines.filter((l) => l.startsWith("Agent: ") || l.startsWith("User: ")).join("\n"));
  const internal = normalizeForMatch(
    lines.filter((l) => /^(Tool_Call|Tool_Result|System_Note|Agent_Handoff):/.test(l)).join("\n"),
  );
  if (claims.some((c) => spoken.includes(c))) return data;
  if (!claims.some((c) => internal.includes(c))) return data;
  return {
    hallucinated: false,
    score: 1.0,
    reason: "The accused text appears only in internal tool/runtime events, not in anything the agent spoke.",
    technical_reason: `dropped: every quoted claim was found only in a tool/runtime event line (Tool_Call/Tool_Result/System_Note), which the hallucination dimension excludes as accusation targets. Original verdict: ${data.technical_reason}`,
  };
}

export function withoutOutOfSegmentFire(
  data: HallucinationRaw,
  node: NodeEvalInput,
  ctx: ConversationInput,
): HallucinationRaw {
  if (!data.hallucinated) return data;
  const claims = quotedClaims(data.technical_reason);
  if (claims.length === 0) return data;
  const nodeText = normalizeForMatch(renderNodeTranscript(node));
  if (claims.some((c) => nodeText.includes(c))) return data;
  const fullText = normalizeForMatch(ctx.full_transcript);
  if (!claims.some((c) => fullText.includes(c))) return data;
  return {
    hallucinated: false,
    score: 1.0,
    reason: "The accused line was spoken in a different node's segment and is judged by that node's own evaluation.",
    technical_reason: `dropped: every quoted claim was spoken in another node's segment (absent from this node's transcript, present in the conversation history); the owning node's evaluation judges it against its own instructions. Original verdict: ${data.technical_reason}`,
  };
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
    // adherenceNodePayload drops available_intents — intent descriptions are the
    // intent judge's job, not procedure/policy (SER-6035 #2). Adherence-only:
    // the other node judges keep the shared payload.
    input: adherenceNodePayload(node, ctx),
    schema: InstructionAdherenceRawZ,
    jsonSchema: INSTRUCTION_ADHERENCE_JSON,
    maxTokens: 5000,
    provider,
  });
}
