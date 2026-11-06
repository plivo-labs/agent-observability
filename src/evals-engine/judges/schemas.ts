// AO Eval Engine — strict JSON schemas for the LLM judges (structured output).
//
// Mirrors cx-sqs-worker's `usecases/eval/prompts/*/config.go` field-for-field (same field names/types/required,
// `additionalProperties:false`), but FLAT — no outer metric key — to match AO's judge output + prompts + Zod
// (AO parses the object directly; cx-sqs's wrapper key is only its jsonKey extraction detail). Passed to
// `completeJSON` as `jsonSchema` with `strict:true` so the Vibe *responses* gateway forces exact JSON — without
// it the model can free-form → parse fail → eval_error. The generation writer already uses strict json_schema on
// the same gateway, so this is proven. This is NOT from the plugins folder (the SDK delegates output shaping to
// LiveKit's `_LLMJudge`); it's the cx-sqs construct. The 2 programmatic judges call no LLM and need no schema.
// The conversation-axis judge schemas (detection/sentiment/stt) live in the section at the bottom.

type JsonSchema = Record<string, unknown>;

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const int = { type: "integer" } as const;
const strArray = { type: "array", items: { type: "string" } } as const;
const arrayOf = (items: JsonSchema) => ({ type: "array", items });

/** An object schema with EVERY property required + additionalProperties:false (strict-mode requirement).
 *  Key order is decode order under strict json_schema, so reasoning fields go before the verdict they justify. */
const obj = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Wrap an inner schema into the `jsonSchema` arg completeJSON expects. strict:true (cx-sqs parity). */
const strict = (name: string, schema: JsonSchema) => ({ name, schema, strict: true }) as const;

// ── node judges ────────────────────────────────────────────────────────────────
export const HALLUCINATION_JSON = strict(
  "eval_hallucination",
  obj({ technical_reason: str, unsupported_claim: str, reason: str, hallucinated: bool, score: num }),
);

export const NODE_LOOP_JSON = strict(
  "eval_loop",
  obj({ technical_reason: str, reason: str, loop_detected: bool, score: num }),
);

export const VARIABLE_EXTRACTION_JSON = strict(
  "eval_variable",
  obj({
    technical_reason: str,
    missing_variables: strArray,
    incorrect_variables: strArray,
    reason: str,
    extraction_successful: bool,
    score: num,
  }),
);

export const INTENT_JSON = strict(
  "eval_intent",
  obj({ technical_reason: str, reason: str, intent_not_found: bool, intent_wrongly_identified: bool }),
);

// instruction adherence — the 4 sub-metrics (mirror cx-sqs node/instruction/config.go exactly).
// config_conflicts leads: the rubric resolves instruction conflicts before any sub-dimension can fail.
const MISSED_STEP = obj({ step: str, reason_code: str, details: str, severity: str });
const ISSUE = obj({ category: str, reason_code: str, details: str });
export const INSTRUCTION_ADHERENCE_JSON = strict(
  "eval_instruction",
  obj({
    config_conflicts: arrayOf(obj({ forbidding_line: str, permitting_line: str, behaviour: str })),
    objective_progress: obj({ technical_reason: str, reason: str, reason_code: str, achieved: bool, score: num }),
    procedure_compliance: obj({ technical_reason: str, missed_steps: arrayOf(MISSED_STEP), reason: str, reason_code: str, score: num }),
    interaction_quality: obj({ technical_reason: str, issues: arrayOf(ISSUE), reason: str, reason_code: str, score: num }),
    policy_boundary_compliance: obj({ technical_reason: str, reason: str, reason_code: str, passed: bool, score: num }),
  }),
);

// ── goal judge ───────────────────────────────────────────────────────────────────
// AO uses the flat array shape (matching our GoalRawZ + OUT_GOAL prompt), not cx-sqs's per-goal-name keys.
export const GOAL_JSON = strict(
  "eval_goal",
  obj({ goals: arrayOf(obj({ goal_name: str, achieved: bool, reason: str, technical_reason: str })) }),
);

// ── criteria judge ─────────────────────────────────────────────────────────────────
// `met` / `accuracy_score` are nullable (a conditional criterion whose precondition never
// occurred returns applicable:false with both null). Strict mode requires every key + no extras.
const boolOrNull = { type: ["boolean", "null"] } as const;
const numOrNull = { type: ["number", "null"] } as const;
export const CRITERIA_JSON = strict(
  "eval_criteria",
  obj({
    criteria: arrayOf(
      obj({ id: int, description: str, applicable: bool, met: boolOrNull, accuracy_score: numOrNull, evidence: str }),
    ),
  }),
);

// ── conversation-axis judges (detection / sentiment / stt) ──────────────────────
// Sentiment is enum-constrained (strict JSON schema + Zod) so the model can't
// emit an off-enum value that the producer's pass rule and the console's
// fallback would classify differently — with only these five values, both
// reduce to the same result and the emitted user_sentiment.passed is the
// single source of truth.
export const SENTIMENT_VALUES = ["positive", "neutral", "negative", "confused", "not_applicable"] as const;
export const DETECTION_JSON = strict("eval_detection", obj({ technical_reason: str, reason: str, detected: bool }));
export const SENTIMENT_JSON = strict("eval_sentiment", obj({ technical_reason: str, reason: str, sentiment: { type: "string", enum: SENTIMENT_VALUES } }));
export const STT_JSON = strict("eval_stt", obj({ technical_reason: str, reason: str, error_count: int, recovered_count: int }));