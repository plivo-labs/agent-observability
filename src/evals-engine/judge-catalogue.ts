// The default-judge catalogue: one entry per judge AO ships, with the prompt
// split (body / output / fill slots) the registry stores. Consumed by
// scripts/generate-judge-seed.ts (migration seed) and the parity tests, so the
// DB rows, the shipped constants, and the override plumbing can never drift
// from each other without a test failing.
import {
  HALLUCINATION, VARIABLE_EXTRACTION, LOOP_DETECTION, INSTRUCTION_ADHERENCE,
  INTENT_IDENTIFICATION, OUT_HALLUCINATION, OUT_VARIABLE, OUT_LOOP,
  OUT_INSTRUCTION, OUT_INTENT,
} from "./judges/instructions.js";
import {
  VOICEMAIL, BOT, CALL_SCREENING, LOW_ENGAGEMENT, WRONG_NUMBER, DO_NOT_DISTURB,
  USER_SENTIMENT, STT, OUT_DETECTION, OUT_SENTIMENT, OUT_STT,
} from "./judges/conversation-judges.js";
import {
  CONFIG_DEFAULT_REVIEW_SYSTEM, FOCUSED_DEFECT_REVIEW_SYSTEM,
} from "./judges/variable-extraction.js";

export type CatalogueRow = {
  name: string;
  display_name: string;
  description: string;
  scope: "node" | "conversation";
  kind: "llm" | "code";
  prompt: { body: string; output: string; slots: string[]; sub_prompts?: Record<string, string> } | null;
  config: Record<string, unknown>;
};

const llm = (
  name: string, display_name: string, description: string,
  scope: CatalogueRow["scope"], body: string, output: string, slots: string[],
  config: Record<string, unknown>, sub_prompts?: Record<string, string>,
): CatalogueRow => ({
  name, display_name, description, scope, kind: "llm",
  prompt: { body, output, slots, ...(sub_prompts ? { sub_prompts } : {}) },
  config,
});

const code = (name: string, display_name: string, description: string): CatalogueRow => ({
  name, display_name, description, scope: "conversation", kind: "code",
  prompt: null, config: {},
});

export const DEFAULT_JUDGE_ROWS: readonly CatalogueRow[] = [
  llm("instructions_adherence", "Instruction adherence",
    "Did the agent follow this node's instructions? Four-part rubric; pass/score derived in code.",
    "node", INSTRUCTION_ADHERENCE, OUT_INSTRUCTION, ["instructions", "objective"], { max_tokens: 5000 }),
  llm("intent_identification", "Intent identification",
    "Was the chosen intent the one the caller expressed? Score derived in code.",
    "node", INTENT_IDENTIFICATION, OUT_INTENT,
    ["available_intents", "chosen_intent", "system_intents"], { max_tokens: 1500 }),
  llm("variable_extraction", "Variable extraction",
    "Were the applicable variables stored with correct values? Verdict canonicalized in code after guarded review.",
    "node", VARIABLE_EXTRACTION, OUT_VARIABLE, ["expected_variables", "actual_variables"],
    { max_tokens: 3000, review_config_default_max_tokens: 600, review_focused_defect_max_tokens: 1000 },
    { review_config_default: CONFIG_DEFAULT_REVIEW_SYSTEM, review_focused_defect: FOCUSED_DEFECT_REVIEW_SYSTEM }),
  llm("hallucination", "Hallucination",
    "Did the agent state anything unsupported by the evidence sources?",
    "node", HALLUCINATION, OUT_HALLUCINATION, [], { max_tokens: 1500 }),
  llm("node_loop", "Agent looping",
    "Did the agent repeat itself without justification instead of advancing?",
    "node", LOOP_DETECTION, OUT_LOOP, [], { max_tokens: 1500 }),
  llm("voicemail_detection", "Voicemail", "Did the call reach voicemail instead of a person?",
    "conversation", VOICEMAIL, OUT_DETECTION, [], { max_tokens: 1500 }),
  llm("bot_detection", "Bot / IVR", "Was the counterparty an automated system rather than a human?",
    "conversation", BOT, OUT_DETECTION, [], { max_tokens: 1500 }),
  llm("call_screening", "Call screening", "Did an unresolved automated screening system answer?",
    "conversation", CALL_SCREENING, OUT_DETECTION, [], { max_tokens: 1500 }),
  llm("low_engagement", "Low engagement", "Did a human answer but never engage with the topic?",
    "conversation", LOW_ENGAGEMENT, OUT_DETECTION, [], { max_tokens: 1500 }),
  llm("wrong_number", "Wrong number", "Did the caller indicate they are not the intended recipient?",
    "conversation", WRONG_NUMBER, OUT_DETECTION, [], { max_tokens: 1500 }),
  llm("do_not_disturb", "Do not disturb", "Did the caller ask not to be contacted again?",
    "conversation", DO_NOT_DISTURB, OUT_DETECTION, [], { max_tokens: 1500 }),
  llm("user_sentiment", "User sentiment",
    "The caller's predominant emotional state; pass rule (not negative/confused) applied in code.",
    "conversation", USER_SENTIMENT, OUT_SENTIMENT, [], { max_tokens: 1500 }),
  llm("stt", "STT quality",
    "Speech-to-text error and recovery counts. Stored in the verdict blob; not fanned out as a row.",
    "conversation", STT, OUT_STT, [], { max_tokens: 3000 }),
  code("user_never_spoke", "Caller never spoke",
    "The caller produced no turn at all. Decided in code from the transcript."),
  code("human_transfer", "Human transfer",
    "The call was handed to a human. Decided in code from the transfer:human session tag."),
];
