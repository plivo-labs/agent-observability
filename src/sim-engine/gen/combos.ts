// AO Simulation Engine — combo libraries + allocation constants (Phase 1.1).
//
// Ported VERBATIM from the orchestrator service `usecases/eval/scenario_generator.py` (the constants
// block, ~L456-690). These are DATA (persona archetypes, conversation patterns,
// scoring weights), NOT the sensitive prompt text — so they are committed (the design notes
// git-ignore only `prompts.ts`). The deterministic allocator (1.4) depends on these
// EXACT values + ids, so do not "improve" them — parity with the orchestrator service requires them
// byte-for-byte.

export interface PersonaCombo {
  style: string;
  verbosity: string;
  emotional_state: string;
  behavioral_traits: string[];
}

export interface EntityFormatCombo {
  entity_pattern: string;
  target_entities: unknown[];
}

export interface RuntimeStressCombo {
  interruption: boolean;
  stt_noise: boolean;
  non_answer: boolean;
}

export interface MockProfile {
  result_profile: string;
}

export interface ConversationPattern {
  traits: string[];
  tags: string[];
  scenario_types: string[];
  persona_ids: string[];
  entity_id: string;
  stress_id: string;
}

export const SCENARIO_TYPES = [
  "clean_baseline",
  "messy_success",
  "recovery_success",
  "boundary_pressure",
] as const;
export type ScenarioType = (typeof SCENARIO_TYPES)[number];

export const MOCK_RESULT_PROFILES = ["success", "empty", "ambiguous", "recoverable_failure"] as const;

export const CANONICAL_TRAITS = [
  "cooperative",
  "self_corrects",
  "goes_off_topic",
  "tests_if_bot",
  "gives_partial_info",
  "contradicts_self",
  "asks_questions_mid_flow",
  "hesitant",
  "rushes",
  "provides_unsolicited_info",
  "gives_wrong_format",
  "switches_language",
] as const;

export const TRAIT_ALIASES: Record<string, string> = {
  interrupts: "rushes",
  mid_flow_questions: "asks_questions_mid_flow",
  non_responsive: "gives_partial_info",
  partial_info: "gives_partial_info",
  bot_testing: "tests_if_bot",
  language_switch: "switches_language",
};

export const TRAIT_TAGS: Record<string, string> = {
  self_corrects: "self_correction",
  goes_off_topic: "off_topic",
  tests_if_bot: "bot_testing",
  gives_partial_info: "partial_info",
  contradicts_self: "contradiction",
  asks_questions_mid_flow: "mid_flow_questions",
  hesitant: "hesitation",
  rushes: "rushing",
  provides_unsolicited_info: "unsolicited_info",
  gives_wrong_format: "wrong_format",
  switches_language: "language_switch",
};

export const PERSONA_COMBOS: Record<string, PersonaCombo> = {
  P01: { style: "direct", verbosity: "low", emotional_state: "neutral", behavioral_traits: ["cooperative"] },
  P02: { style: "casual", verbosity: "normal", emotional_state: "neutral", behavioral_traits: ["cooperative"] },
  P03: { style: "rushed", verbosity: "low", emotional_state: "impatient", behavioral_traits: ["rushes", "gives_partial_info"] },
  P04: { style: "skeptical", verbosity: "normal", emotional_state: "skeptical", behavioral_traits: ["asks_questions_mid_flow", "hesitant"] },
  P05: { style: "confused", verbosity: "normal", emotional_state: "confused", behavioral_traits: ["gives_partial_info", "self_corrects"] },
  P06: { style: "frustrated", verbosity: "normal", emotional_state: "frustrated", behavioral_traits: ["contradicts_self", "rushes"] },
  P07: { style: "chatty", verbosity: "high", emotional_state: "neutral", behavioral_traits: ["provides_unsolicited_info"] },
  P08: { style: "uncertain", verbosity: "normal", emotional_state: "confused", behavioral_traits: ["self_corrects", "contradicts_self"] },
  P09: { style: "boundary-testing", verbosity: "high", emotional_state: "skeptical", behavioral_traits: ["asks_questions_mid_flow", "tests_if_bot"] },
  P10: { style: "language-mixed", verbosity: "normal", emotional_state: "neutral", behavioral_traits: ["switches_language", "cooperative"] },
  P11: { style: "off-topic", verbosity: "high", emotional_state: "confused", behavioral_traits: ["goes_off_topic", "asks_questions_mid_flow"] },
  P12: { style: "format-messy", verbosity: "normal", emotional_state: "neutral", behavioral_traits: ["gives_wrong_format", "self_corrects"] },
  P13: { style: "chatty", verbosity: "high", emotional_state: "impatient", behavioral_traits: ["provides_unsolicited_info", "rushes"] },
  // P14-P19: ported (in the orchestrator service) from AO's PERSONA_CATALOG. Schema-uniform with P01-P13;
  // only style/verbosity/emotional_state/behavioral_traits are consumed by the writer.
  P14: { style: "polite", verbosity: "normal", emotional_state: "happy", behavioral_traits: ["cooperative"] },
  P15: { style: "rushed", verbosity: "normal", emotional_state: "impatient", behavioral_traits: ["rushes", "contradicts_self", "asks_questions_mid_flow"] },
  P16: { style: "mumbling", verbosity: "low", emotional_state: "neutral", behavioral_traits: ["gives_partial_info", "gives_wrong_format"] },
  P17: { style: "inquisitive", verbosity: "high", emotional_state: "skeptical", behavioral_traits: ["asks_questions_mid_flow", "hesitant"] },
  P18: { style: "demanding", verbosity: "normal", emotional_state: "angry", behavioral_traits: ["rushes", "contradicts_self", "gives_partial_info"] },
  P19: { style: "boundary-testing", verbosity: "high", emotional_state: "skeptical", behavioral_traits: ["tests_if_bot", "goes_off_topic"] },
};

export const ENTITY_FORMAT_COMBOS: Record<string, EntityFormatCombo> = {
  E01: { entity_pattern: "clean_direct_answers", target_entities: [] },
  E02: { entity_pattern: "partial_values_need_followup", target_entities: [] },
  E03: { entity_pattern: "wrong_format_values", target_entities: [] },
  E04: { entity_pattern: "multiple_values_in_one_utterance", target_entities: [] },
  E05: { entity_pattern: "minimal_acknowledgements", target_entities: [] },
  E06: { entity_pattern: "self_corrected_values", target_entities: [] },
  E07: { entity_pattern: "fragmented_entity_across_turns", target_entities: [] },
  E08: { entity_pattern: "spelled_or_digit_by_digit_values", target_entities: [] },
};

export const RUNTIME_STRESS_COMBOS: Record<string, RuntimeStressCombo> = {
  R00: { interruption: false, stt_noise: false, non_answer: false },
  R01: { interruption: false, stt_noise: false, non_answer: true },
  R02: { interruption: true, stt_noise: false, non_answer: false },
  R03: { interruption: false, stt_noise: true, non_answer: false },
  R04: { interruption: true, stt_noise: false, non_answer: true },
};

export const MOCK_PROFILES: Record<string, MockProfile> = {
  M_SUCCESS: { result_profile: "success" },
  M_EMPTY: { result_profile: "empty" },
  M_AMBIGUOUS: { result_profile: "ambiguous" },
  M_RECOVERABLE_FAILURE: { result_profile: "recoverable_failure" },
};

export const CONVERSATION_PATTERNS: Record<string, ConversationPattern> = {
  clean_direct: { traits: ["cooperative"], tags: ["clean_direct"], scenario_types: ["clean_baseline"], persona_ids: ["P01", "P02"], entity_id: "E01", stress_id: "R00" },
  minimal_ack: { traits: ["cooperative"], tags: ["minimal_ack"], scenario_types: ["messy_success"], persona_ids: ["P01", "P02"], entity_id: "E05", stress_id: "R00" },
  repeated_hello: { traits: ["gives_partial_info"], tags: ["repeated_hello"], scenario_types: ["recovery_success"], persona_ids: ["P05"], entity_id: "E05", stress_id: "R01" },
  identity_challenge: { traits: ["asks_questions_mid_flow", "hesitant"], tags: ["identity_challenge"], scenario_types: ["boundary_pressure", "recovery_success"], persona_ids: ["P04", "P09"], entity_id: "E02", stress_id: "R00" },
  source_challenge: { traits: ["asks_questions_mid_flow", "hesitant"], tags: ["source_challenge"], scenario_types: ["boundary_pressure", "recovery_success"], persona_ids: ["P04"], entity_id: "E02", stress_id: "R00" },
  purpose_challenge: { traits: ["asks_questions_mid_flow"], tags: ["purpose_challenge"], scenario_types: ["boundary_pressure"], persona_ids: ["P04", "P09"], entity_id: "E02", stress_id: "R00" },
  bot_suspicion: { traits: ["tests_if_bot", "asks_questions_mid_flow"], tags: ["bot_suspicion"], scenario_types: ["boundary_pressure"], persona_ids: ["P09"], entity_id: "E02", stress_id: "R00" },
  bad_time_call_later: { traits: ["rushes", "gives_partial_info"], tags: ["bad_time_call_later"], scenario_types: ["boundary_pressure", "recovery_success"], persona_ids: ["P03"], entity_id: "E02", stress_id: "R02" },
  fragmented_entity: { traits: ["gives_partial_info"], tags: ["fragmented_entity", "partial_info"], scenario_types: ["recovery_success"], persona_ids: ["P05", "P12"], entity_id: "E07", stress_id: "R01" },
  self_correction: { traits: ["self_corrects"], tags: ["self_correction"], scenario_types: ["recovery_success"], persona_ids: ["P08", "P12"], entity_id: "E06", stress_id: "R00" },
  contradiction: { traits: ["contradicts_self", "self_corrects"], tags: ["contradiction"], scenario_types: ["recovery_success"], persona_ids: ["P08", "P06"], entity_id: "E06", stress_id: "R01" },
  asks_question_instead: { traits: ["asks_questions_mid_flow"], tags: ["asks_question_instead"], scenario_types: ["recovery_success", "boundary_pressure"], persona_ids: ["P04"], entity_id: "E02", stress_id: "R00" },
  low_interest: { traits: ["rushes", "gives_partial_info"], tags: ["low_interest"], scenario_types: ["boundary_pressure"], persona_ids: ["P03"], entity_id: "E02", stress_id: "R00" },
  alternate_channel_request: { traits: ["asks_questions_mid_flow"], tags: ["alternate_channel_request"], scenario_types: ["boundary_pressure"], persona_ids: ["P04", "P09"], entity_id: "E02", stress_id: "R00" },
  language_switch: { traits: ["switches_language"], tags: ["language_switch"], scenario_types: ["messy_success", "recovery_success"], persona_ids: ["P10"], entity_id: "E01", stress_id: "R00" },
  spelled_out_entity: { traits: ["gives_wrong_format"], tags: ["spelled_out_entity", "wrong_format"], scenario_types: ["recovery_success"], persona_ids: ["P12"], entity_id: "E08", stress_id: "R03" },
  digit_by_digit_entity: { traits: ["gives_wrong_format"], tags: ["digit_by_digit_entity", "wrong_format"], scenario_types: ["recovery_success"], persona_ids: ["P12"], entity_id: "E08", stress_id: "R03" },
  gatekeeper_or_hold: { traits: ["gives_partial_info", "asks_questions_mid_flow"], tags: ["gatekeeper_or_hold"], scenario_types: ["boundary_pressure"], persona_ids: ["P04"], entity_id: "E02", stress_id: "R01" },
  topic_out_of_scope: { traits: ["goes_off_topic", "asks_questions_mid_flow"], tags: ["topic_out_of_scope"], scenario_types: ["boundary_pressure"], persona_ids: ["P11", "P09"], entity_id: "E02", stress_id: "R00" },
  // Patterns wiring the ported AO personas (P14-P19) so the allocator can select them.
  ao_happy_path: { traits: ["cooperative"], tags: ["ao_happy_path", "happy_path"], scenario_types: ["clean_baseline", "messy_success"], persona_ids: ["P14"], entity_id: "E01", stress_id: "R00" },
  ao_interrupts_and_switches: { traits: ["rushes", "contradicts_self", "asks_questions_mid_flow"], tags: ["ao_interrupts_and_switches", "interruption"], scenario_types: ["messy_success", "boundary_pressure"], persona_ids: ["P15"], entity_id: "E04", stress_id: "R02" },
  ao_noisy_mumbled_entity: { traits: ["gives_partial_info", "gives_wrong_format"], tags: ["ao_noisy_mumbled_entity", "stt_noise", "wrong_format"], scenario_types: ["recovery_success"], persona_ids: ["P16"], entity_id: "E07", stress_id: "R03" },
  ao_knowledge_grill: { traits: ["asks_questions_mid_flow", "hesitant"], tags: ["ao_knowledge_grill"], scenario_types: ["boundary_pressure"], persona_ids: ["P17"], entity_id: "E02", stress_id: "R00" },
  ao_aggressive_refund_demand: { traits: ["rushes", "contradicts_self", "gives_partial_info"], tags: ["ao_aggressive_refund_demand", "adversarial"], scenario_types: ["boundary_pressure"], persona_ids: ["P18"], entity_id: "E02", stress_id: "R00" },
  ao_prompt_injection: { traits: ["tests_if_bot", "goes_off_topic"], tags: ["ao_prompt_injection", "adversarial"], scenario_types: ["boundary_pressure"], persona_ids: ["P19"], entity_id: "E02", stress_id: "R00" },
};

/** scenario_type → candidate conversation patterns (used by the allocator's candidate builder). */
export const SCENARIO_TYPE_DEFAULT_PATTERNS: Record<string, string[]> = {
  clean_baseline: ["clean_direct", "ao_happy_path"],
  messy_success: ["minimal_ack", "language_switch", "ao_interrupts_and_switches"],
  recovery_success: ["fragmented_entity", "self_correction", "contradiction", "spelled_out_entity", "digit_by_digit_entity", "asks_question_instead", "ao_noisy_mumbled_entity"],
  boundary_pressure: ["topic_out_of_scope", "identity_challenge", "purpose_challenge", "bot_suspicion", "bad_time_call_later", "low_interest", "alternate_channel_request", "ao_knowledge_grill", "ao_aggressive_refund_demand", "ao_prompt_injection"],
};

export const EXECUTABLE_NODE_TYPES = new Set<string>(["start", "initiate_call", "ai_agent_v2", "http_request", "branch_v2", "ai_action", "prompt"]);
export const SUPPORTED_TERMINAL_NODE_TYPES = new Set<string>(["end_conversation", "call_forward"]);
export const BLOCKED_NODE_TYPES = new Set<string>(["queue_and_route", "ai_agent_whatsapp"]);

export const SCENARIO_TYPE_ORDER: Record<string, number> = {
  clean_baseline: 0,
  messy_success: 1,
  recovery_success: 2,
  boundary_pressure: 3,
};

export const PRIORITY_WEIGHT: Record<string, number> = { core: 3.0, boundary: 2.0, secondary: 1.0 };
export const RISK_WEIGHT: Record<string, number> = { high: 2.0, medium: 1.0, low: 0.0 };

export const PATTERN_PRIORITY: Record<string, number> = {
  clean_direct: 10,
  fragmented_entity: 88,
  self_correction: 86,
  topic_out_of_scope: 86,
  identity_challenge: 84,
  minimal_ack: 82,
  source_challenge: 82,
  purpose_challenge: 82,
  low_interest: 80,
  alternate_channel_request: 78,
  language_switch: 76,
  bot_suspicion: 74,
  contradiction: 72,
  asks_question_instead: 70,
  bad_time_call_later: 68,
  spelled_out_entity: 66,
  digit_by_digit_entity: 64,
  repeated_hello: 50,
  gatekeeper_or_hold: 40,
  ao_prompt_injection: 90,
  ao_aggressive_refund_demand: 87,
  ao_noisy_mumbled_entity: 85,
  ao_knowledge_grill: 83,
  ao_interrupts_and_switches: 81,
  ao_happy_path: 12,
};

export const ALLOCATION_AXES = [
  "capability_id",
  "scenario_type",
  "conversation_pattern_id",
  "persona_combo_id",
  "entity_format_combo_id",
  "runtime_stress_combo_id",
  "route_id",
  "mock_profile_id",
] as const;
export type AllocationAxis = (typeof ALLOCATION_AXES)[number];

export const HIGH_RISK_TRIPLES: ReadonlyArray<readonly [AllocationAxis, AllocationAxis, AllocationAxis]> = [
  ["capability_id", "scenario_type", "conversation_pattern_id"],
  ["capability_id", "route_id", "mock_profile_id"],
  ["scenario_type", "persona_combo_id", "entity_format_combo_id"],
];

// Applied to a pattern's score only when the flow is an outbound call (source: the
// allocator's scoring helper, ~L1911 in scenario_generator.py).
export const OUTBOUND_PATTERN_BOOST: Record<string, number> = {
  gatekeeper_or_hold: 50,
  bad_time_call_later: 30,
  low_interest: 15,
  alternate_channel_request: 15,
};

export const MAX_EXISTING_SCENARIO_SUMMARIES = 200;
export const WRITER_CHUNK_SIZE = 10;
export const WRITER_CHUNK_RETRIES = 1;
export const WRITER_SLOT_RETRIES = 1;
export const WRITER_MAX_OUTPUT_TOKENS = 12000;
export const PLANNER_MAX_OUTPUT_TOKENS = 8000;

export const OUT_OF_SCOPE_ROUTE_TERMS = [
  "voicemail", "voice_mail", "answering_machine", "answering machine",
  "no_answer", "no answer", "busy_rejected", "busy rejected", "failed_call", "failed call",
];

export const OUT_OF_SCOPE_SCENARIO_TERMS = [
  "voicemail", "voice_mail", "answering_machine", "answering machine", "busy rejected", "failed call",
];

export interface MockableNodeSpec {
  node_type: string;
  description: string;
  outcome_source: "fixed" | "conditions";
  fixed_outcomes: string[];
}

export const MOCKABLE_NODE_REGISTRY: Record<string, MockableNodeSpec> = {
  http_request: {
    node_type: "http_request",
    description: "Makes an external HTTP API call.",
    outcome_source: "fixed",
    fixed_outcomes: ["success", "error", "failed"],
  },
  branch_v2: {
    node_type: "branch_v2",
    description: "Routes the flow based on conditional rules. Pick the condition alias that matches the scenario's intended path.",
    outcome_source: "conditions",
    fixed_outcomes: [],
  },
};
