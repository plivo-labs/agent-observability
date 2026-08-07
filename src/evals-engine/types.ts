// AO Eval Engine — public types.
//
// Two contracts live here:
//   1. The INPUT the engine consumes (`ConversationInput`) — one entry per AI node
//      (its config + the turns that ran at that node) plus the flow goals.
//   2. The OUTPUT the engine emits (`EvaluationResult`) — a stable JSON shape a consumer can
//      render or persist verbatim (node-level metrics + goal results).
//
// evaluateSimulation scores the node axis + goal axis. The conversation axis
// (sentiment/bot/voicemail/...) is scored separately by the conversation judges.

// ── INPUT ───────────────────────────────────────────────────────────────────────

/** Text tag appended to platform idle boilerplate (user-idle reminders /
 *  idle-hangup lines) so LLM judges can see WHY a turn is exempt. Machine-side
 *  filtering keys on EvalTurn.idle, not this string — the tag text is
 *  display-only context inside the judges' prompts. */
export const IDLE_TAG = "[system idle prompt]";

/** One conversational turn that ran at a node (the eval-relevant slice of a turn_completed event). */
export interface EvalTurn {
  node_uuid: string;
  /** User utterance for this turn (may be empty on a silent/transition turn). */
  user: string;
  /** Agent utterance for this turn (may be empty on a non-spoken transition). */
  agent: string;
  /** Intent the agent/framework selected on this turn ("" when none). */
  intent: string;
  /** Tool calls returned with a simulation turn. Each valid call is rendered
   *  as bare Tool_Call/Tool_Result evidence for the judges while remaining on
   *  its original conversational turn (so turn counts do not change). */
  tool_calls?: unknown[];
  /** True for synthetic evidence lines (tool calls, handoffs, system notes)
   *  that are NOT spoken words. The speech-only transcript filters on this
   *  flag instead of re-matching the rendered label strings. */
  evidence?: boolean;
  /** True for platform idle boilerplate (reminder / idle-hangup lines). The
   *  loop judge's deterministic exclusion filters on this flag (same pattern
   *  as `evidence`); the IDLE_TAG suffix on the turn text is only the
   *  judges' human-readable context. */
  idle?: boolean;
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
  /** Per-variable recording rules (how/when each should be captured) — rendered
   *  into the variable judge's expected-variables list so conditional rules
   *  ("leave empty unless…") are judged against, not guessed at. */
  variable_rules?: Record<string, string>;
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
  /** Speech-only variant of full_transcript: internal evidence lines
   *  (System_Note/Tool_Call/Tool_Result/Agent_Handoff) removed. Used by the
   *  conversation-axis detection judges, which must classify what was SAID on
   *  the call — a config note like "if voicemail, leave a message" rendered as
   *  an agent line would otherwise skew voicemail/engagement/sentiment.
   *  Absent (sim path) ⇒ judges fall back to full_transcript. */
  speech_transcript?: string;
  /** Runtime context the platform supplied to the live agent — trigger inputs
   *  and mid-flow HTTP/tool outputs (flat string→string). A value present here
   *  is grounded evidence for the hallucination judge even if it never appears
   *  in the transcript. Absent when the sender didn't attach it. */
  global_variables?: Record<string, string>;
  /** TTS pronunciation map (word→guide). The engine rewrites each word to its
   *  guide before speaking, so the transcript holds the guide form; the
   *  hallucination judge treats guide and word as equivalent. */
  pronunciation_guides?: Record<string, string>;
  /** Session transport/channel (e.g. "livekit", "twilio", "chat", "sms",
   *  "whatsapp"). Gates the voice-only conversation detections (voicemail /
   *  bot / call-screening) so they don't fire on text transcripts. Absent ⇒
   *  treated as voice (the historical default). */
  transport?: string;
}

// ── OUTPUT (the stable verdict contract a consumer renders/persists) ─────────

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

// ── conversation-level metrics ────────────────────────────────────────────────
// The node/goal path leaves these zero-valued; the conversation judges populate
// the real values when scoring the whole-transcript axis.

interface CmDetection {
  detected: boolean;
  detected_value: number;
  reason: string;
  technical_reason: string;
  /** False when the judge could not run (provider outage). Consumers skip
   *  unavailable detections rather than reading `detected:false` as a real
   *  "not detected" verdict. Always set: real judges set true, the zero
   *  placeholder (zeroConversationMetrics) sets false. */
  available: boolean;
}
export interface SimConversationMetrics {
  answered: boolean;
  voicemail_detected: CmDetection;
  bot_detected: CmDetection;
  call_screening: CmDetection;
  low_engagement: CmDetection;
  wrong_number: CmDetection;
  do_not_disturb: CmDetection;
  user_sentiment: {
    sentiment: string;
    reason: string;
    technical_reason: string;
    /** False when the sentiment judge could not run. Always set. */
    available: boolean;
    /** Code-derived pass/fail, emitted once here so consumers (fan-out,
     *  config-service, console) read it instead of re-deriving the rule. */
    passed?: boolean;
  };
  silent_call: boolean;
  customer_engaged: boolean;
  conversation_status: { status: string; reason: string; technical_reason: string };
  is_livekit: boolean;
  is_agent_runner: boolean;
  /** STT quality axis. `available:false` marks "the judge did not run" (skipped
   *  or errored) so consumers don't read the zero counts as a confident "clean
   *  call". `error_count`/`recovered_count` are only meaningful when available. */
  stt: { error_count: number; recovered_count: number; available: boolean };
  /** The caller produced no turn at all (zero `User:` lines with content).
   *  Decided in CODE from the transcript, channel-agnostic — not a telephony
   *  measure. `available:false` when there was no transcript to judge (an empty
   *  transcript is undecidable, never a clean "user spoke"). */
  user_never_spoke: CmDetection;
}

/** What `evaluateSimulation` returns: the node + goal axes only.
 *  The run-path adapter wraps this into the emitted `EvaluationResult`. */
export interface NodeGoalEvaluation {
  node_evaluations: NodeEvaluation[];
  /** Omitted when no goals are configured (UI: "No goals configured"). */
  goal_evaluation?: GoalEvaluation;
}

/** The `evaluation` payload attached to `scenario_completed`: a wrapper header +
 *  conversation_metrics (zero-valued on the node/goal path) + the node/goal axes.
 *  The adapter always sets every header field, so they are required (no producer emits a partial wrapper). */
export interface EvaluationResult extends NodeGoalEvaluation {
  /** Wrapper header — cosmetic identifiers echoed for consumers; no judge reads them. */
  flow_uuid: string;
  flow_name: string;
  run_uuid: string;
  /** Zero-valued on the node/goal path; populated by the conversation judges. */
  conversation_metrics: SimConversationMetrics;
}

/** What the run path receives back: either an evaluation, or an error flag (never both, never throws). */
export interface SimEvalOutcome {
  evaluation?: EvaluationResult;
  /** Set (as `true`) instead of `evaluation` when scoring failed. */
  eval_error?: boolean;
}
