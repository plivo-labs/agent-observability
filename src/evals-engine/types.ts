// AO Eval Engine — public types.
//
// Two contracts live here:
//   1. The INPUT the engine consumes (`ConversationInput`) — assembled from a simulation transcript
//      (conversation-input.ts::fromSimTranscript). Mirrors what cx-sqs's transcript_builder.go feeds
//      its ConversationEvaluator: per-AI-node config + the turns that ran at that node + the flow goals.
//   2. The OUTPUT the engine emits (`EvaluationResult`) — byte-compatible with the `evaluation` JSONB
//      the console renders and aiassist persists verbatim. Field names/keys are copied from cx-sqs's
//      `models/eval.go` (ConversationEvaluation / NodeLevelMetrics / GoalEvaluation) so the CXSQS|AO
//      engine toggle shows AO's scores in the same UI with zero downstream changes.
//
// Phase 1 = node axis + goal axis only (cx-sqs sim sets SkipConversationEval=true). The conversation
// axis (sentiment/bot/voicemail/STT/TD) is Phase 2 (live) and intentionally absent here.

// ── INPUT ───────────────────────────────────────────────────────────────────────

/** One conversational turn that ran at a node (the eval-relevant slice of a turn_completed event). */
export interface EvalTurn {
  node_uuid: string;
  /** User utterance for this turn (may be empty on a silent/transition turn). */
  user: string;
  /** Agent utterance for this turn (may be empty on a non-spoken transition). */
  agent: string;
  /** Intent the agent/framework selected on this turn ("" when none). */
  intent: string;
}

/** A single AI node the scenario visited, with the config + turns needed to score it. */
export interface NodeEvalInput {
  node_uuid: string;
  node_name: string;
  /** The node's own instructions/prompt (canonical `config.instructions`). */
  node_prompt: string;
  /** Available intents declared on the node (for context; intent scoring is programmatic). */
  available_intents: unknown[];
  /** Intent the agent actually chose at this node (last detected intent). */
  chosen_intent: string;
  /** Variable names the node is configured to extract (`config.extract_variables[].variable_name`). */
  required_variables: string[];
  /** Variables actually extracted at this node (`variables_by_node[node_uuid]`). */
  extracted_variables: Record<string, unknown>;
  /** Turns that ran at this node, in order. */
  turns: EvalTurn[];
  /** Number of turns at this node. */
  turn_count: number;
}

/** A configured conversation goal (from `agent_settings.conversation_goals`). */
export interface GoalInput {
  goal_name: string;
  goal_instructions: string;
  /** DB id when present (AO flows may not carry one → 0). */
  flow_goal_id: number;
}

/** The full eval input for one scenario run. */
export interface ConversationInput {
  flow_name: string;
  /** Global/system prompt (flow `systemPrompt`). */
  global_prompt: string;
  /** AI nodes visited during the run, in order. */
  nodes: NodeEvalInput[];
  /** Configured goals; empty ⇒ goal axis is skipped (UI: "No goals configured"). */
  goals: GoalInput[];
  /** The whole conversation rendered as text (context for hallucination/loop/goal judges). */
  full_transcript: string;
}

// ── OUTPUT (the console contract — keys copied from cx-sqs models/eval.go) ─────────

export interface ObjectiveProgressMetrics {
  achieved: boolean;
  score: number;
  reason_code: string;
  reason: string;
  technical_reason: string;
}
export interface MissedStep {
  step: string;
  severity: string; // "critical" | "minor"
  reason_code: string;
  details: string;
}
export interface ProcedureComplianceMetrics {
  /** Code-derived: passed iff no missed step is "critical". */
  passed: boolean;
  score: number;
  missed_steps: MissedStep[];
  reason_code: string;
  reason: string;
  technical_reason: string;
}
export interface InteractionQualityIssue {
  category: string;
  reason_code: string;
  details: string;
}
export interface InteractionQualityMetrics {
  score: number;
  issues: InteractionQualityIssue[];
  reason_code: string;
  reason: string;
  technical_reason: string;
}
export interface PolicyBoundaryComplianceMetrics {
  passed: boolean;
  score: number;
  reason_code: string;
  reason: string;
  technical_reason: string;
}
export interface InstructionsAdherenceMetrics {
  /** Code-derived: objective.achieved ∧ procedure.passed ∧ policy.passed. */
  adherence_passed: boolean;
  /** Code-derived weighted score: .35·obj + .25·proc + .25·inter + .15·policy. */
  score: number;
  reason: string;
  technical_reason: string;
  objective_progress: ObjectiveProgressMetrics | null;
  procedure_compliance: ProcedureComplianceMetrics | null;
  interaction_quality: InteractionQualityMetrics | null;
  policy_boundary_compliance: PolicyBoundaryComplianceMetrics | null;
}

export interface IntentIdentificationMetrics {
  reason: string;
  technical_reason: string;
  intent_not_found: boolean;
  intent_wrongly_identified: boolean;
  score: number;
}
export interface VariableExtractionMetrics {
  extraction_successful: boolean;
  score: number;
  reason: string;
  technical_reason: string;
  /** Variables the node is configured to extract (from `config.extract_variables[]`) — deterministic. */
  required_variables: string[];
  /** Required variables the user provided but the agent did NOT extract (LLM). */
  missing_variables: string[];
  /** Variables the agent extracted with a wrong/ungrounded value (LLM). */
  incorrect_variables: string[];
}
export interface HallucinationMetrics {
  hallucinated: boolean;
  score: number;
  reason: string;
  technical_reason: string;
}
export interface NodeLoopMetrics {
  loop_detected: boolean;
  score: number;
  reason: string;
  technical_reason: string;
}

export interface NodeEvaluation {
  node_uuid: string;
  node_name: string;
  turn_count: number;
  instructions_adherence: InstructionsAdherenceMetrics;
  intent_identification: IntentIdentificationMetrics;
  variable_extraction: VariableExtractionMetrics;
  hallucination: HallucinationMetrics;
  node_loop: NodeLoopMetrics;
}

export interface GoalResult {
  goal_name: string;
  flow_goal_id: number;
  achieved: boolean;
  reason: string;
  technical_reason: string;
}
export interface GoalEvaluation {
  goals: GoalResult[];
}

// ── conversation-level metrics (empty for sim — cx-sqs parity wrapper) ────────────
// cx-sqs emits a zero-valued `ConversationLevelMetrics{}` on the sim path (SkipConversationEval skips the LLM
// call but still returns the struct), wrapped in ConversationEvaluation. AO mirrors that all-default shape for
// exact download-JSON parity. Cosmetic only — no consumer reads these for sim (Phase 2 live eval populates them).

interface CmDetection {
  detected: boolean;
  detected_value: number;
  reason: string;
  technical_reason: string;
}
export interface SimConversationMetrics {
  answered: boolean;
  voicemail_detected: CmDetection;
  cx_voicemail_detected: number;
  cx_call_screening_detected: number;
  bot_detected: CmDetection;
  call_screening: CmDetection;
  low_engagement: CmDetection;
  wrong_number: CmDetection;
  do_not_disturb: CmDetection;
  user_sentiment: { sentiment: string; reason: string; technical_reason: string };
  silent_call: boolean;
  customer_engaged: boolean;
  conversation_status: { status: string; reason: string; technical_reason: string };
  is_livekit: boolean;
  is_agent_runner: boolean;
  stt: { error_count: number; recovered_count: number };
}

/** What `evaluateSimulation` returns: the node + goal axes only (cx-sqs SkipConversationEval).
 *  The run-path adapter wraps this into the emitted `EvaluationResult`. */
export interface NodeGoalEvaluation {
  node_evaluations: NodeEvaluation[];
  /** Omitted when no goals are configured (UI: "No goals configured"). */
  goal_evaluation?: GoalEvaluation;
}

/** The `evaluation` payload attached to `scenario_completed`. Mirrors cx-sqs `ConversationEvaluation`
 *  (models/eval.go): the wrapper header + conversation_metrics (empty for sim) + the node/goal axes.
 *  The adapter always sets every header field, so they are required (no producer emits a partial wrapper). */
export interface EvaluationResult extends NodeGoalEvaluation {
  /** cx-sqs wrapper header — cosmetic (no consumer reads them); present for exact raw-JSON parity. */
  flow_uuid: string;
  flow_name: string;
  run_uuid: string;
  /** Empty/default for sim (SkipConversationEval); populated only by Phase 2 live eval. */
  conversation_metrics: SimConversationMetrics;
}

/** What the run path receives back: either an evaluation, or an error flag (never both, never throws). */
export interface SimEvalOutcome {
  evaluation?: EvaluationResult;
  /** Set (as `true`) instead of `evaluation` when scoring failed; mirrors cx-sqs `eval_error`. */
  eval_error?: boolean;
}
