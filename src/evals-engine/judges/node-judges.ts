import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import { renderFullTranscript } from "../conversation-input.js";
import { z } from "zod";
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

const ConfigDefaultReviewZ = z.object({
  reviews: z.array(
    z.object({
      variable_name: z.string(),
      exception_established: z.boolean(),
      evidence: z.string().default(""),
    }),
  ),
});

const CONFIG_DEFAULT_REVIEW_JSON = {
  name: "eval_variable_config_default_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reviews"],
    properties: {
      reviews: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["variable_name", "exception_established", "evidence"],
          properties: {
            variable_name: { type: "string" },
            exception_established: { type: "boolean" },
            evidence: { type: "string" },
          },
        },
      },
    },
  },
} as const;

const FocusedDefectReviewZ = z.object({
  reviews: z.array(
    z.object({
      variable_name: z.string(),
      issue_type: z.enum(["missing", "incorrect"]),
      defect_confirmed: z.boolean(),
      evidence: z.string().default(""),
    }),
  ),
});

const FOCUSED_DEFECT_REVIEW_JSON = {
  name: "eval_variable_focused_defect_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reviews"],
    properties: {
      reviews: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["variable_name", "issue_type", "defect_confirmed", "evidence"],
          properties: {
            variable_name: { type: "string" },
            issue_type: { type: "string", enum: ["missing", "incorrect"] },
            defect_confirmed: { type: "boolean" },
            evidence: { type: "string" },
          },
        },
      },
    },
  },
} as const;

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

/** Keep the variable judge's decisive inputs at the end of its user payload.
 * Node prompts can be very long and instruction-shaped; repeating this compact
 * data contract after them prevents the model from replacing the configured
 * extraction rule with a workflow assumption from the agent prompt. */
function variablePayload(node: NodeEvalInput, ctx: ConversationInput): Record<string, unknown> {
  const cutoffConfirmed = finalRecordingBatchCutOff(node);
  return {
    ...nodePayload(node, ctx),
    variable_rules: node.variable_rules ?? {},
    variable_judge_contract:
      "Judge only whether applicable caller-provided information was captured correctly. " +
      "Each variable's recording rule is authoritative; do not invent prerequisites or exceptions. " +
      "Anything from an unreached or inapplicable path is not missing. " +
      "Absent workflow defaults and backend, platform, tool, and lookup values are not caller extraction. " +
      (cutoffConfirmed
        ? "FINAL RECORDING BATCH CUTOFF CONFIRMED from structured turn order: missing_variables must be empty for that pending batch."
        : "If an interrupted ending/transfer is followed by the caller and no later agent/tool turn, the configured final recording batch had no opportunity to run."),
  };
}

function finalRecordingBatchCutOff(node: NodeEvalInput): boolean {
  const spoken = node.turns.filter((turn) => !turn.evidence && !turn.idle && (turn.user || turn.agent));
  const last = spoken.at(-1);
  const previous = spoken.at(-2);
  if (!last?.user || last.agent || !previous?.agent.toLowerCase().includes("[interrupted]")) return false;

  const prompt = node.node_prompt.toLowerCase();
  return (
    /(?:submit|record|extract|capture)[\s\S]{0,160}\bbefore\b[\s\S]{0,80}\b(?:transfer|handoff|ending|end)\b/.test(prompt) ||
    /\bbefore\b[\s\S]{0,80}\b(?:transfer|handoff|ending|end)\b[\s\S]{0,160}(?:submit|record|extract|capture)/.test(prompt)
  );
}

function judgeClassification(variableName: string, rule: string | undefined): string {
  const normalizedRule = rule?.toLowerCase() ?? "";
  if (isConfigDirectedDefaultRule(normalizedRule)) {
    return "CONFIG-DIRECTED DEFAULT — valid without an affirmative caller utterance; apply only explicitly stated exceptions";
  }
  if (/(?:summary|status|disposition|outcome|classification|internal[_ -]?score|remarks?)/i.test(variableName)) {
    return "WORKFLOW FIELD — never missing caller information; do not place in missing_variables or incorrect_variables";
  }
  if (/backend|platform|initial context|tool result|lookup result|runtime/.test(normalizedRule)) {
    return "PLATFORM/BACKEND FIELD — outside caller extraction";
  }
  return "CALLER-CAPTURE CANDIDATE — still require applicability and an explicit caller-provided value";
}

function isConfigDirectedDefaultRule(rule: string | undefined): boolean {
  return /does not dispute|unless (?:the )?caller disputes|configured default|by default/.test(rule?.toLowerCase() ?? "");
}

function isExplicitSpeechRule(rule: string | undefined): boolean {
  return /(?:only )?when (?:the )?caller explicitly (?:states?|says?|provides?|confirms?)|only if (?:the )?caller explicitly|only when explicitly supported|when (?:the )?caller states? it/.test(
    rule?.toLowerCase() ?? "",
  );
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
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
          const classification = judgeClassification(v, rule);
          return rule ? `- ${v} — judge classification: ${classification} — recording rule: ${rule}` : `- ${v} — judge classification: ${classification}`;
        })
        .join("\n")
    : "(none)";
  const actualEntries = Object.entries(node.extracted_variables ?? {});
  const actual = actualEntries.length ? actualEntries.map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n") : "(none)";
  const result = await runLlmJudge({
    system: systemForVariableExtraction(expected, actual),
    input: variablePayload(node, ctx),
    schema: VariableExtractionRawZ,
    jsonSchema: VARIABLE_EXTRACTION_JSON,
    maxTokens: 3000,
    provider,
  });

  // A model can acknowledge the final-batch cutoff and still list the pending
  // values as missing. When the structured event order proves that no recorder
  // turn occurred, and there are no stored values that could be incorrect or
  // extra, omission is impossible by construction. Keep this guard deliberately
  // narrow so completed calls and wrong stored values remain model-judged.
  if (
    actualEntries.length === 0 &&
    finalRecordingBatchCutOff(node) &&
    result.data.incorrect_variables.length === 0
  ) {
    result.data = {
      ...result.data,
      extraction_successful: true,
      score: 1.0,
      reason: "The configured final recording batch had no turn in which to run.",
      technical_reason: `${result.data.technical_reason || ""} Overridden by structured final-batch cutoff: interrupted ending/transfer, caller reply, and no later agent or tool turn.`.trim(),
      missing_variables: [],
      incorrect_variables: [],
    };
  }

  const defaultCandidates = result.data.incorrect_variables.filter(
    (name) =>
      Object.hasOwn(node.extracted_variables, name) &&
      isConfigDirectedDefaultRule(node.variable_rules?.[name]),
  );
  if (defaultCandidates.length > 0) {
    try {
      const review = await runLlmJudge({
        system:
          "Review ONLY whether the caller explicitly established an exception to each configured default. " +
          "The variable's recording rule is authoritative. An unanswered question, missing identity confirmation, silence, a busy/callback request, or model uncertainty is NOT an exception. " +
          "Set exception_established=true only when the caller's words actually satisfy an exception written in that variable's rule; cite that caller evidence. Return one review per candidate.",
        input: {
          candidates: defaultCandidates.map((name) => ({
            variable_name: name,
            recording_rule: node.variable_rules?.[name] ?? "",
            stored_value: node.extracted_variables[name],
          })),
          node_transcript: renderNodeTranscript(node),
        },
        schema: ConfigDefaultReviewZ,
        jsonSchema: CONFIG_DEFAULT_REVIEW_JSON,
        maxTokens: 600,
        provider,
      });
      result.usage = addUsage(result.usage, review.usage);

      const cleared = new Set(
        review.data.reviews
          .filter((entry) => defaultCandidates.includes(entry.variable_name) && !entry.exception_established)
          .map((entry) => entry.variable_name),
      );
      if (cleared.size > 0) {
        const incorrectVariables = result.data.incorrect_variables.filter((name) => !cleared.has(name));
        const hasExtraVariable = actualEntries.some(([name]) => !node.required_variables.includes(name));
        const successful = !hasExtraVariable && result.data.missing_variables.length === 0 && incorrectVariables.length === 0;
        result.data = {
          ...result.data,
          extraction_successful: successful,
          score: successful ? 1.0 : result.data.score,
          reason: successful ? "Configured default values are valid; the caller established no rule exception." : result.data.reason,
          technical_reason: `${result.data.technical_reason || ""} Cleared by focused config-default review: ${[...cleared].join(", ")}.`.trim(),
          incorrect_variables: incorrectVariables,
        };
      }
    } catch {
      // The primary verdict remains usable if the narrow review is unavailable.
    }
  }

  const focusedCandidates = [
    ...result.data.missing_variables
      .filter((name) => !isExplicitSpeechRule(node.variable_rules?.[name]))
      .map((name) => ({
        variable_name: name,
        issue_type: "missing" as const,
        recording_rule: node.variable_rules?.[name] ?? "",
      })),
    ...result.data.incorrect_variables
      .filter(
        (name) =>
          !isConfigDirectedDefaultRule(node.variable_rules?.[name]) &&
          !isExplicitSpeechRule(node.variable_rules?.[name]),
      )
      .map((name) => ({
        variable_name: name,
        issue_type: "incorrect" as const,
        recording_rule: node.variable_rules?.[name] ?? "",
        stored_value: node.extracted_variables[name],
      })),
  ];
  if (focusedCandidates.length > 0) {
    try {
      const review = await runLlmJudge({
        system:
          "Verify ONLY the proposed variable defects against the exact recording rule and caller transcript. " +
          "For missing: confirm only when the caller explicitly stated an applicable value in that variable's own terms and it was not stored. Reject inferred/derived values, absent defaults such as not_asked or no_questions, unopened paths, duplicate/sibling demands, workflow fields, and backend/platform/tool/lookup data. " +
          "For incorrect: confirm only when the stored value materially conflicts with the caller or the exact rule. A value explicitly authorized by the rule is valid, including the same caller fact stored under two variables whose rules both allow it. " +
          "Do not add new defects. Return one review for every candidate and cite only caller words or the exact rule.",
        input: {
          candidates: focusedCandidates,
          node_transcript: renderNodeTranscript(node),
        },
        schema: FocusedDefectReviewZ,
        jsonSchema: FOCUSED_DEFECT_REVIEW_JSON,
        maxTokens: 1000,
        provider,
      });
      result.usage = addUsage(result.usage, review.usage);

      const rejected = new Set(
        review.data.reviews
          .filter((entry) => {
            const key = `${entry.issue_type}:${entry.variable_name}`;
            return !entry.defect_confirmed && focusedCandidates.some((candidate) => `${candidate.issue_type}:${candidate.variable_name}` === key);
          })
          .map((entry) => `${entry.issue_type}:${entry.variable_name}`),
      );
      if (rejected.size > 0) {
        const missingVariables = result.data.missing_variables.filter((name) => !rejected.has(`missing:${name}`));
        const incorrectVariables = result.data.incorrect_variables.filter((name) => !rejected.has(`incorrect:${name}`));
        const hasExtraVariable = actualEntries.some(([name]) => !node.required_variables.includes(name));
        const successful = !hasExtraVariable && missingVariables.length === 0 && incorrectVariables.length === 0;
        result.data = {
          ...result.data,
          extraction_successful: successful,
          score: successful ? 1.0 : result.data.score,
          reason: successful ? "All applicable caller-provided variables were captured correctly." : result.data.reason,
          technical_reason: `${result.data.technical_reason || ""} Unconfirmed proposals removed by focused defect review: ${[...rejected].join(", ")}.`.trim(),
          missing_variables: missingVariables,
          incorrect_variables: incorrectVariables,
        };
      }
    } catch {
      // Keep the primary verdict if this precision-only verification is unavailable.
    }
  }

  return result;
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
