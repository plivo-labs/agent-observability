import { finalBatchContext, finalBatchCoversVariable, lookupBackedVariable, outOfScopeVariableKind, type FinalBatchContext } from "./variable-guards.js";
import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import { sumUsage } from "../../llm/usage.js";
import { z } from "zod";
import type { ConversationInput, NodeEvalInput } from "../types.js";
import { systemForVariableExtraction } from "./instructions.js";
import { nodePayload } from "./node-judge-payload.js";
import { promptSub } from "./judge-prompts.js";
import { runLlmJudge } from "./run-llm-judge.js";
import { VARIABLE_CONTRACT } from "../judge-contracts.js";
import { NODE_EVIDENCE_SCOPE, scopedNodeEvidence } from "../node-evidence.js";
import { VARIABLE_EXTRACTION_JSON } from "./schemas.js";
import { VariableExtractionRawZ, type VariableExtractionRaw } from "./types.js";

const GuardedReviewZ = z.object({
  reviews: z.array(
    z.object({
      variable_name: z.string(),
      issue_type: z.enum(["missing", "incorrect"]),
      defect_confirmed: z.boolean(),
      // Older/non-strict responses cannot clear an incorrect value by omission.
      stored_value_supported: z.boolean().default(false),
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
          required: ["variable_name", "issue_type", "defect_confirmed", "stored_value_supported", "evidence"],
          properties: {
            variable_name: { type: "string" },
            issue_type: { type: "string", enum: ["missing", "incorrect"] },
            defect_confirmed: { type: "boolean" },
            stored_value_supported: {
              type: "boolean",
              description: "For incorrect candidates, true only when the exact rule and observed evidence authorize the stored value, including every prerequisite for that value. Absence of a caller denial is not support unless the rule defines that default. False for missing candidates or uncertain support.",
            },
            evidence: { type: "string" },
          },
        },
      },
    },
  },
} as const;

type VariableIssueKey = `missing:${string}` | `incorrect:${string}`;
type IssueType = "missing" | "incorrect";

interface GuardedCandidate {
  variable_name: string;
  issue_type: IssueType;
  recording_rule: string;
  stored_value?: unknown;
}

function judgeClassification(variableName: string, rule: string | undefined): string {
  const normalizedRule = rule?.toLowerCase() ?? "";
  const outOfScope = outOfScopeVariableKind(variableName, normalizedRule);
  if (lookupBackedVariable(normalizedRule)) {
    return "LOOKUP FIELD — taken from the lookup/tool result for the record the caller confirmed; missing when that visible result holds the value and nothing was recorded";
  }
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
    extracted_variables: Object.fromEntries(Object.entries(node.extracted_variables).filter(([name]) => node.required_variables.includes(name))),
    variable_rules: node.variable_rules ?? {},
    variable_recording_schedule: batch.recordingSchedule,
    variable_judge_contract: VARIABLE_CONTRACT + " " +
      "Judge only whether applicable caller-provided information was captured correctly. " +
      "Each variable's recording rule is authoritative; do not invent prerequisites or exceptions. " +
      "Anything from an unreached or inapplicable path is not missing. " +
      "CALL ENDED EARLY: if the transcript simply STOPS before the agent ever asked for a value — the caller hung up or the call was cut off mid-flow — " +
      "that value is UNREACHABLE, not missing. A value recorded WRONGLY still fails however the call ended. " +
      "Absent workflow defaults and backend or platform values are not caller extraction; the exceptions are a value the rule names for a situation that happened and a field the rule takes from a visible lookup or tool result. " +
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
    system: `${system}\n${NODE_EVIDENCE_SCOPE}\n${VARIABLE_CONTRACT}`,
    input: { candidates, ...input },
    schema: GuardedReviewZ,
    jsonSchema: GUARDED_REVIEW_JSON,
    maxTokens,
    provider,
  });
}

function reconcileRejectedVariableIssues(
  data: VariableExtractionRaw,
  rejected: Set<VariableIssueKey>,
  reviewNotes: string[],
): VariableExtractionRaw {
  if (rejected.size === 0) return data;

  const missingVariables = data.missing_variables.filter((name) => !rejected.has(`missing:${name}`));
  const incorrectVariables = data.incorrect_variables.filter((name) => !rejected.has(`incorrect:${name}`));
  const successful = missingVariables.length === 0 && incorrectVariables.length === 0;
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

function canonicalizeVariableVerdict(data: VariableExtractionRaw): VariableExtractionRaw {
  const successful = data.missing_variables.length === 0 && data.incorrect_variables.length === 0;
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
  "For missing: confirm only when the caller explicitly stated an applicable value in that variable's own terms and it was not stored. Reject inferred/derived values, absent defaults the rule does not name for what happened (such as not_asked or no_questions), unopened paths, duplicate/sibling demands, workflow fields, and backend/platform data. " +
  "A clear caller no to a reached yes/no/unclear question is an explicit value; an early not-interested ending does not excuse failing to record that answer after a normal close. " +
  "Confirm a missing value the rule itself names for a situation that clearly happened (for example not_offered on an immediate transfer), and a field the rule takes from a lookup or tool result that the transcript shows holds the value. " +
  "For incorrect: confirm when the stored value conflicts with the caller or the exact rule, including an outcome or status whose required conditions are not established. A caller need not explicitly deny a category for it to be unsupported. " +
  "To clear an incorrect candidate, set stored_value_supported=true and cite the exact rule plus evidence satisfying ALL of its prerequisites. Merely agreeing to talk or confirming identity does not establish shared requirements, interest, or qualification. An early cutoff excuses pending omissions, never an unsupported value already recorded. " +
  "A value explicitly authorized by the rule is valid, including the same caller fact stored under two variables whose rules both allow it. If support is uncertain, set stored_value_supported=false and retain the proposed defect. " +
  "Use the supplied final-batch context for pending batch fields; preserve a defect whose exact rule separately requires immediate or earlier recording. " +
  "Do not add defects. Return one review for every candidate and cite only caller words or the exact rule.";

export async function runVariableExtractionJudge(
  node: NodeEvalInput,
  ctx: ConversationInput,
  provider?: LlmProvider,
): Promise<{ data: VariableExtractionRaw; usage: LlmUsage }> {
  if (node.required_variables.length === 0) {
    return {
      data: {
        extraction_successful: true,
        score: 1.0,
        reason: "No variables declared on this node — extraction not applicable.",
        technical_reason: "skipped: node declares no required_variables",
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
  const actualEntries = Object.entries(node.extracted_variables ?? {}).filter(([name]) => node.required_variables.includes(name));
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

  const rejected = new Set<VariableIssueKey>([
    ...result.data.missing_variables.filter(name => !node.required_variables.includes(name)).map(name => `missing:${name}` as const),
    ...result.data.incorrect_variables.filter(name => !node.required_variables.includes(name)).map(name => `incorrect:${name}` as const),
  ]);
  const reviewNotes: string[] = rejected.size ? ["Excluded fields outside the configured extraction metric"] : [];
  const outOfScope = (name: string) =>
    outOfScopeVariableKind(name, node.variable_rules?.[name]) !== undefined && !lookupBackedVariable(node.variable_rules?.[name]);
  const outOfScopeKeys = [
    ...result.data.missing_variables.filter(outOfScope).map((name) => `missing:${name}` as const),
    ...result.data.incorrect_variables.filter(outOfScope).map((name) => `incorrect:${name}` as const),
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
          promptSub("variable_extraction", "review_config_default", CONFIG_DEFAULT_REVIEW_SYSTEM),
          defaultCandidates,
          { ...scopedNodeEvidence(node, ctx), variable_sources: node.variable_sources },
          600,
          provider,
        ).catch(() => undefined)
      : undefined,
    focusedCandidates.length
      ? runGuardedReview(
          promptSub("variable_extraction", "review_focused_defect", FOCUSED_DEFECT_REVIEW_SYSTEM),
          focusedCandidates,
          {
            ...scopedNodeEvidence(node, ctx),
            variable_sources: node.variable_sources,
            final_recording_batch_cutoff: batch.cutoffConfirmed,
            recording_schedule: batch.recordingSchedule,
          },
          1000,
          provider,
        ).catch(() => undefined)
      : undefined,
  ]);

  for (const review of [
    { result: defaultReview, candidates: defaultCandidates, requireValueSupport: false, note: "Cleared by focused config-default review" },
    { result: focusedReview, candidates: focusedCandidates, requireValueSupport: true, note: "Cleared by focused defect review" },
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
      .filter((entry) => candidateKeys.has(`${entry.issue_type}:${entry.variable_name}`) && !entry.defect_confirmed &&
        (!review.requireValueSupport || entry.issue_type !== "incorrect" ||
          (entry.stored_value_supported && entry.evidence.trim().length > 0)))
      .map((entry) => `${entry.issue_type}:${entry.variable_name}` as VariableIssueKey);
    for (const key of cleared) rejected.add(key);
    if (cleared.length > 0) reviewNotes.push(review.note);
  }

  result.data = reconcileRejectedVariableIssues(
    result.data,
    rejected,
    reviewNotes,
  );
  result.data = canonicalizeVariableVerdict(result.data);
  return result;
}

export { finalBatchContext, finalBatchCoversVariable, outOfScopeVariableKind, type FinalBatchContext } from "./variable-guards.js";
