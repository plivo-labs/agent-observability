import { z } from "zod";

// AO Eval Engine — judge interface + Zod schemas.
//
// Two kinds of schema:
//   * RAW judge output (what the LLM is asked to return, validated by completeJSON). These match the
//     fields cx-sqs asks its eval LLM for, MINUS the code-derived ones (adherence score/adherence_passed
//     and procedure.passed are computed in aggregate.ts, never trusted from the model).
//   * The CONTRACT (EvaluationResultZ) — the final emitted shape, used to validate in tests.
//
// Scores are coerced (a model may emit "0.8") and reasons default to "" so a terse judge never fails Zod.

const scoreZ = z.coerce.number();
const reasonZ = z.string().default("");

// ── raw LLM outputs (per judge) ───────────────────────────────────────────────────

export const HallucinationRawZ = z.object({
  hallucinated: z.boolean(),
  score: scoreZ,
  reason: reasonZ,
  technical_reason: reasonZ,
});
export type HallucinationRaw = z.infer<typeof HallucinationRawZ>;

export const VariableExtractionRawZ = z.object({
  extraction_successful: z.boolean(),
  score: scoreZ,
  reason: reasonZ,
  technical_reason: reasonZ,
  // Entity-level detail (cx-sqs CLAUDE.md variant). `required_variables` is re-attached in code from the
  // node config; the LLM supplies missing/incorrect. Default [] so a terse judge never fails Zod.
  missing_variables: z.array(z.string()).default([]),
  incorrect_variables: z.array(z.string()).default([]),
});
export type VariableExtractionRaw = z.infer<typeof VariableExtractionRawZ>;

export const NodeLoopRawZ = z.object({
  loop_detected: z.boolean(),
  score: scoreZ,
  reason: reasonZ,
  technical_reason: reasonZ,
});
export type NodeLoopRaw = z.infer<typeof NodeLoopRawZ>;

// intent — the LLM returns the two booleans (cx-sqs intent/config.go); `score` is derived (1 iff both false).
export const IntentIdentificationRawZ = z.object({
  intent_not_found: z.boolean(),
  intent_wrongly_identified: z.boolean(),
  reason: reasonZ,
  technical_reason: reasonZ,
});
export type IntentIdentificationRaw = z.infer<typeof IntentIdentificationRawZ>;

// instruction adherence — the LLM returns the 4 sub-metrics; `passed`/weighted score are derived.
const MissedStepZ = z.object({
  step: reasonZ,
  severity: z.string().default("minor"),
  reason_code: reasonZ,
  details: reasonZ,
});
const InteractionIssueZ = z.object({
  category: reasonZ,
  reason_code: reasonZ,
  details: reasonZ,
});
export const InstructionAdherenceRawZ = z.object({
  objective_progress: z.object({
    achieved: z.boolean(),
    score: scoreZ,
    reason_code: reasonZ,
    reason: reasonZ,
    technical_reason: reasonZ,
  }),
  procedure_compliance: z.object({
    score: scoreZ,
    reason_code: reasonZ,
    missed_steps: z.array(MissedStepZ).default([]),
    reason: reasonZ,
    technical_reason: reasonZ,
  }),
  interaction_quality: z.object({
    score: scoreZ,
    reason_code: reasonZ,
    issues: z.array(InteractionIssueZ).default([]),
    reason: reasonZ,
    technical_reason: reasonZ,
  }),
  policy_boundary_compliance: z.object({
    passed: z.boolean(),
    score: scoreZ,
    reason_code: reasonZ,
    reason: reasonZ,
    technical_reason: reasonZ,
  }),
});
export type InstructionAdherenceRaw = z.infer<typeof InstructionAdherenceRawZ>;

// goal — the LLM returns one entry per goal (flow_goal_id is re-attached from the input in code).
export const GoalRawZ = z.object({
  goals: z
    .array(
      z.object({
        goal_name: z.string(),
        achieved: z.boolean(),
        reason: reasonZ,
        technical_reason: reasonZ,
      }),
    )
    .default([]),
});
export type GoalRaw = z.infer<typeof GoalRawZ>;

// ── the emitted contract (for test validation) ────────────────────────────────────

const InstructionsAdherenceZ = z.object({
  adherence_passed: z.boolean(),
  score: z.number(),
  reason: z.string(),
  technical_reason: z.string(),
  objective_progress: z.any().nullable(),
  procedure_compliance: z.any().nullable(),
  interaction_quality: z.any().nullable(),
  policy_boundary_compliance: z.any().nullable(),
});
const NodeEvaluationZ = z.object({
  node_uuid: z.string(),
  node_name: z.string(),
  turn_count: z.number(),
  instructions_adherence: InstructionsAdherenceZ,
  intent_identification: z.object({
    reason: z.string(),
    technical_reason: z.string(),
    intent_not_found: z.boolean(),
    intent_wrongly_identified: z.boolean(),
    score: z.number(),
  }),
  variable_extraction: z.object({
    extraction_successful: z.boolean(),
    score: z.number(),
    reason: z.string(),
    technical_reason: z.string(),
    required_variables: z.array(z.string()),
    missing_variables: z.array(z.string()),
    incorrect_variables: z.array(z.string()),
  }),
  hallucination: z.object({
    hallucinated: z.boolean(),
    score: z.number(),
    reason: z.string(),
    technical_reason: z.string(),
  }),
  node_loop: z.object({
    loop_detected: z.boolean(),
    score: z.number(),
    reason: z.string(),
    technical_reason: z.string(),
  }),
});
// The evaluator's output: node + goal axes only (no wrapper header).
export const NodeGoalEvaluationZ = z.object({
  node_evaluations: z.array(NodeEvaluationZ),
  goal_evaluation: z
    .object({
      goals: z.array(
        z.object({
          goal_name: z.string(),
          flow_goal_id: z.number(),
          achieved: z.boolean(),
          reason: z.string(),
          technical_reason: z.string(),
        }),
      ),
    })
    .optional(),
});

// The emitted `evaluation` wrapper = node/goal axes + the required cx-sqs ConversationEvaluation header
// (the adapter always sets all four; no producer emits a partial wrapper).
export const EvaluationResultZ = NodeGoalEvaluationZ.extend({
  flow_uuid: z.string(),
  flow_name: z.string(),
  run_uuid: z.string(),
  conversation_metrics: z.record(z.string(), z.unknown()),
});
