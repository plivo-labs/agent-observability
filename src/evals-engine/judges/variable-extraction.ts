import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import { sumUsage } from "../../llm/usage.js";
import { z } from "zod";
import type { ConversationInput, NodeEvalInput } from "../types.js";
import { systemForVariableExtraction } from "./instructions.js";
import { nodePayload, renderNodeTranscript } from "./node-judge-payload.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { VARIABLE_EXTRACTION_JSON } from "./schemas.js";
import { VariableExtractionRawZ, type VariableExtractionRaw } from "./types.js";

const GuardedReviewZ = z.object({
  reviews: z.array(
    z.object({
      variable_name: z.string(),
      issue_type: z.enum(["missing", "incorrect"]),
      defect_confirmed: z.boolean(),
      evidence: z.string().default(""),
    }),
  ),
});

const GUARDED_REVIEW_JSON = {
  name: "eval_variable_guarded_review",
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

const RECORDING_ACTION = String.raw`(?:submit|submission|record|extract|capture)`;
const TERMINAL_ACTION = String.raw`(?:transfer|handoff|ending|end)`;
const RECORDING_SCHEDULE_LINE = new RegExp(`${RECORDING_ACTION}.*${TERMINAL_ACTION}|${TERMINAL_ACTION}.*${RECORDING_ACTION}`, "i");
const RECORDING_BEFORE_TERMINAL = new RegExp(
  `${RECORDING_ACTION}[\\s\\S]{0,160}\\bbefore\\b[\\s\\S]{0,80}\\b${TERMINAL_ACTION}\\b|` +
    `\\bbefore\\b[\\s\\S]{0,80}\\b${TERMINAL_ACTION}\\b[\\s\\S]{0,160}${RECORDING_ACTION}`,
);
const BATCH_SCOPE_AFTER_ACTION = new RegExp(
  `${RECORDING_ACTION}[\\s\\S]{0,140}\\b(?:all|remaining|collected|captured|known)\\b[\\s\\S]{0,80}\\b(?:data|details|information|fields|variables)\\b`,
);
const BATCH_SCOPE_BEFORE_ACTION = new RegExp(
  `\\b(?:all|remaining|collected|captured|known)\\b[\\s\\S]{0,80}\\b(?:data|details|information|fields|variables)\\b[\\s\\S]{0,140}${RECORDING_ACTION}`,
);
const BATCH_PRONOUN_SCHEDULE = new RegExp(
  `\\brecord them\\b[\\s\\S]{0,80}\\b(?:before|prior to)\\b[\\s\\S]{0,80}\\b${TERMINAL_ACTION}\\b`,
);
const LEGACY_LEAD_BATCH_OBJECT = /\blead (?:data|details)\b/;
const INTERRUPTED_TERMINAL_TURN = /\b(?:transfer|handoff|ending|end)\b/i;
const EARLY_RECORDING_RULE = /immediately|at once|as soon as|after each|record (?:it|this|the value) (?:when|after)/;

const WORKFLOW_RULE_EVIDENCE =
  /agent-authored|workflow (?:field|status|disposition|label)|mapped (?:workflow )?(?:status|disposition|outcome)|internal score|concise summary|normalized overall (?:interest )?status|final (?:workflow )?(?:status|disposition|outcome|classification)|final outcome (?:was )?reached/;
const PLATFORM_RULE_EVIDENCE =
  /backend|platform|initial context|tool (?:result|output)|lookup (?:result|output)|runtime|internal (?:id|identifier)|returned by (?:the |a )?[^.]{0,40}(?:action|tool|lookup)/;

type VariableIssueKey = `missing:${string}` | `incorrect:${string}`;
type IssueType = "missing" | "incorrect";

interface GuardedCandidate {
  variable_name: string;
  issue_type: IssueType;
  recording_rule: string;
  stored_value?: unknown;
}

interface FinalBatchContext {
  cutoffConfirmed: boolean;
  recordingSchedule: string;
  schedulesCompleteBatch: boolean;
}

function recordingScheduleExcerpt(node: NodeEvalInput): string {
  return node.node_prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => RECORDING_SCHEDULE_LINE.test(line))
    .slice(0, 5)
    .join("\n")
    .slice(0, 2000);
}

function finalBatchContext(node: NodeEvalInput): FinalBatchContext {
  const recordingSchedule = recordingScheduleExcerpt(node);
  const chronological = node.turns.filter((turn) => !turn.idle && (turn.user || turn.agent));
  const last = chronological.at(-1);
  const previous = chronological.at(-2);
  const hasInterruptedTerminalTail = !!(
    last?.user &&
    !last.agent &&
    !last.evidence &&
    previous?.agent.toLowerCase().includes("[interrupted]") &&
    INTERRUPTED_TERMINAL_TURN.test(previous.agent) &&
    !previous.evidence
  );
  const prompt = node.node_prompt.toLowerCase();
  const cutoffConfirmed = hasInterruptedTerminalTail && RECORDING_BEFORE_TERMINAL.test(prompt);
  const schedule = recordingSchedule.toLowerCase();
  const schedulesCompleteBatch =
    cutoffConfirmed &&
    (BATCH_SCOPE_AFTER_ACTION.test(schedule) ||
      BATCH_SCOPE_BEFORE_ACTION.test(schedule) ||
      BATCH_PRONOUN_SCHEDULE.test(schedule) ||
      LEGACY_LEAD_BATCH_OBJECT.test(schedule));

  return { cutoffConfirmed, recordingSchedule, schedulesCompleteBatch };
}

function finalBatchCoversVariable(
  batch: FinalBatchContext,
  node: NodeEvalInput,
  variableName: string,
): boolean {
  if (!batch.schedulesCompleteBatch) return false;
  const rule = node.variable_rules?.[variableName]?.toLowerCase() ?? "";
  return !EARLY_RECORDING_RULE.test(rule);
}

function outOfScopeVariableKind(
  _variableName: string,
  rule: string | undefined,
): "platform" | "workflow" | undefined {
  const normalizedRule = rule?.toLowerCase() ?? "";
  if (PLATFORM_RULE_EVIDENCE.test(normalizedRule)) return "platform";

  // Only the rule can establish a workflow-produced field. A workflow-shaped
  // name alone cannot suppress caller fields such as visa_status.
  if (WORKFLOW_RULE_EVIDENCE.test(normalizedRule)) return "workflow";
  return undefined;
}

function judgeClassification(variableName: string, rule: string | undefined): string {
  const normalizedRule = rule?.toLowerCase() ?? "";
  const outOfScope = outOfScopeVariableKind(variableName, normalizedRule);
  if (outOfScope === "platform") return "PLATFORM/BACKEND FIELD — outside caller extraction";
  if (outOfScope === "workflow") {
    return "WORKFLOW FIELD — never missing caller information; do not place in missing_variables or incorrect_variables";
  }
  if (isConfigDirectedDefaultRule(normalizedRule)) {
    return "CONFIG-DIRECTED DEFAULT — valid without an affirmative caller utterance; apply only explicitly stated exceptions";
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

function variablePayload(
  node: NodeEvalInput,
  ctx: ConversationInput,
  batch: FinalBatchContext,
): Record<string, unknown> {
  return {
    ...nodePayload(node, ctx),
    variable_rules: node.variable_rules ?? {},
    variable_recording_schedule: batch.recordingSchedule,
    variable_judge_contract:
      "Judge only whether applicable caller-provided information was captured correctly. " +
      "Each variable's recording rule is authoritative; do not invent prerequisites or exceptions. " +
      "Anything from an unreached or inapplicable path is not missing. " +
      "Absent workflow defaults and backend, platform, tool, and lookup values are not caller extraction. " +
      (batch.cutoffConfirmed
        ? "FINAL RECORDING BATCH CUTOFF CONFIRMED from structured turn order: do not mark a pending final-batch variable missing unless its own rule required earlier recording."
        : "If an interrupted ending/transfer is followed by the caller and no later agent/tool turn, the configured final recording batch had no opportunity to run."),
  };
}

async function runGuardedReview(
  system: string,
  candidates: GuardedCandidate[],
  input: Record<string, unknown>,
  maxTokens: number,
  provider?: LlmProvider,
) {
  return runLlmJudge({
    system,
    input: { candidates, ...input },
    schema: GuardedReviewZ,
    jsonSchema: GUARDED_REVIEW_JSON,
    maxTokens,
    provider,
  });
}

function reconcileRejectedVariableIssues(
  data: VariableExtractionRaw,
  requiredVariables: string[],
  actualEntries: Array<[string, unknown]>,
  rejected: Set<VariableIssueKey>,
  reviewNotes: string[],
): VariableExtractionRaw {
  if (rejected.size === 0) return data;

  const missingVariables = data.missing_variables.filter((name) => !rejected.has(`missing:${name}`));
  const incorrectVariables = data.incorrect_variables.filter((name) => !rejected.has(`incorrect:${name}`));
  const hasExtraVariable = actualEntries.some(([name]) => !requiredVariables.includes(name));
  const successful = !hasExtraVariable && missingVariables.length === 0 && incorrectVariables.length === 0;
  return {
    ...data,
    extraction_successful: successful,
    score: successful ? 1.0 : data.score,
    reason: successful ? "All applicable caller-provided variables were captured correctly." : data.reason,
    technical_reason: `${data.technical_reason || ""} ${reviewNotes.join("; ")}: ${[...rejected].join(", ")}.`.trim(),
    missing_variables: missingVariables,
    incorrect_variables: incorrectVariables,
  };
}

function canonicalizeVariableVerdict(
  data: VariableExtractionRaw,
  requiredVariables: string[],
  actualEntries: Array<[string, unknown]>,
): VariableExtractionRaw {
  const hasExtraVariable = actualEntries.some(([name]) => !requiredVariables.includes(name));
  const successful = !hasExtraVariable && data.missing_variables.length === 0 && data.incorrect_variables.length === 0;
  if (data.extraction_successful === successful) return data;

  return {
    ...data,
    extraction_successful: successful,
    score: successful ? 1.0 : Math.min(data.score, 0.75),
    reason: successful ? "All applicable caller-provided variables were captured correctly." : data.reason,
    technical_reason: `${data.technical_reason || ""} Verdict normalized from structured missing/incorrect arrays and configured variable names.`.trim(),
  };
}

export const CONFIG_DEFAULT_REVIEW_SYSTEM =
  "Review ONLY whether the caller explicitly established an exception to each configured default. " +
  "The variable's recording rule is authoritative. An unanswered question, missing identity confirmation, silence, a busy/callback request, or model uncertainty is NOT an exception. " +
  "Set defect_confirmed=true only when the caller's words satisfy an exception written in the rule and the stored value violates that exception. Otherwise set it false. " +
  "Return one review per candidate with issue_type=incorrect and cite caller evidence.";

export const FOCUSED_DEFECT_REVIEW_SYSTEM =
  "Verify ONLY the proposed variable defects against the exact recording rule and caller transcript. " +
  "For missing: confirm only when the caller explicitly stated an applicable value in that variable's own terms and it was not stored. Reject inferred/derived values, absent defaults such as not_asked or no_questions, unopened paths, duplicate/sibling demands, workflow fields, and backend/platform/tool/lookup data. " +
  "For incorrect: confirm only when the stored value materially conflicts with the caller or the exact rule. A value explicitly authorized by the rule is valid, including the same caller fact stored under two variables whose rules both allow it. " +
  "Use the supplied final-batch context for pending batch fields; preserve a defect whose exact rule separately requires immediate or earlier recording. " +
  "Do not add defects. Return one review for every candidate and cite only caller words or the exact rule.";

export async function runVariableExtractionJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: VariableExtractionRaw; usage: LlmUsage }> {
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

  const expected = node.required_variables.length
    ? node.required_variables
        .map((variableName) => {
          const rule = node.variable_rules?.[variableName];
          const classification = judgeClassification(variableName, rule);
          return rule
            ? `- ${variableName} — judge classification: ${classification} — recording rule: ${rule}`
            : `- ${variableName} — judge classification: ${classification}`;
        })
        .join("\n")
    : "(none)";
  const actualEntries = Object.entries(node.extracted_variables ?? {});
  const actual = actualEntries.length
    ? actualEntries.map(([name, value]) => `- ${name}: ${JSON.stringify(value)}`).join("\n")
    : "(none)";
  const batch = finalBatchContext(node);
  const result = await runLlmJudge({
    system: systemForVariableExtraction(expected, actual),
    input: variablePayload(node, ctx, batch),
    schema: VariableExtractionRawZ,
    jsonSchema: VARIABLE_EXTRACTION_JSON,
    maxTokens: 3000,
    provider,
  });

  const rejected = new Set<VariableIssueKey>();
  const reviewNotes: string[] = [];
  const outOfScopeKeys = [
    ...result.data.missing_variables
      .filter((name) => outOfScopeVariableKind(name, node.variable_rules?.[name]) !== undefined)
      .map((name) => `missing:${name}` as const),
    ...result.data.incorrect_variables
      .filter((name) => outOfScopeVariableKind(name, node.variable_rules?.[name]) !== undefined)
      .map((name) => `incorrect:${name}` as const),
  ];
  for (const key of outOfScopeKeys) rejected.add(key);
  if (outOfScopeKeys.length > 0) reviewNotes.push("Cleared as out-of-scope workflow/platform fields");

  const cutoffKeys = result.data.missing_variables
    .filter((name) => !rejected.has(`missing:${name}`) && finalBatchCoversVariable(batch, node, name))
    .map((name) => `missing:${name}` as const);
  for (const key of cutoffKeys) rejected.add(key);
  if (cutoffKeys.length > 0) reviewNotes.push("Cleared by structured final-batch schedule");

  const defaultCandidates: GuardedCandidate[] = result.data.incorrect_variables
    .filter(
      (name) =>
        !rejected.has(`incorrect:${name}`) &&
        Object.hasOwn(node.extracted_variables, name) &&
        isConfigDirectedDefaultRule(node.variable_rules?.[name]),
    )
    .map((name) => ({
      variable_name: name,
      issue_type: "incorrect",
      recording_rule: node.variable_rules?.[name] ?? "",
      stored_value: node.extracted_variables[name],
    }));

  const focusedCandidates: GuardedCandidate[] = [
    ...result.data.missing_variables
      .filter((name) => !rejected.has(`missing:${name}`))
      .map((name) => ({
        variable_name: name,
        issue_type: "missing" as const,
        recording_rule: node.variable_rules?.[name] ?? "",
      })),
    ...result.data.incorrect_variables
      .filter(
        (name) =>
          !rejected.has(`incorrect:${name}`) &&
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

  const [defaultReview, focusedReview] = await Promise.all([
    defaultCandidates.length
      ? runGuardedReview(
          CONFIG_DEFAULT_REVIEW_SYSTEM,
          defaultCandidates,
          { node_transcript: renderNodeTranscript(node) },
          600,
          provider,
        ).catch(() => undefined)
      : undefined,
    focusedCandidates.length
      ? runGuardedReview(
          FOCUSED_DEFECT_REVIEW_SYSTEM,
          focusedCandidates,
          {
            node_transcript: renderNodeTranscript(node),
            final_recording_batch_cutoff: batch.cutoffConfirmed,
            recording_schedule: batch.recordingSchedule,
          },
          1000,
          provider,
        ).catch(() => undefined)
      : undefined,
  ]);

  for (const review of [
    { result: defaultReview, candidates: defaultCandidates, note: "Cleared by focused config-default review" },
    { result: focusedReview, candidates: focusedCandidates, note: "Cleared by focused defect review" },
  ]) {
    if (!review.result) continue;
    // sumUsage (llm/usage.ts) is the one place usage arithmetic lives. The local
    // merge this replaces silently dropped reasoningTokens, so a guarded review's
    // invisible spend vanished from the judge's own total.
    result.usage = sumUsage([result.usage, review.result.usage]).usage;
    const candidateKeys = new Set(
      review.candidates.map((candidate) => `${candidate.issue_type}:${candidate.variable_name}`),
    );
    const cleared = review.result.data.reviews
      .filter((entry) => candidateKeys.has(`${entry.issue_type}:${entry.variable_name}`) && !entry.defect_confirmed)
      .map((entry) => `${entry.issue_type}:${entry.variable_name}` as VariableIssueKey);
    for (const key of cleared) rejected.add(key);
    if (cleared.length > 0) reviewNotes.push(review.note);
  }

  result.data = reconcileRejectedVariableIssues(
    result.data,
    node.required_variables,
    actualEntries,
    rejected,
    reviewNotes,
  );
  result.data = canonicalizeVariableVerdict(result.data, node.required_variables, actualEntries);
  return result;
}
