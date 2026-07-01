// AO Eval Engine — strict JSON schemas for the LLM judges (structured output).
//
// Mirrors cx-sqs-worker's `usecases/eval/prompts/*/config.go` field-for-field (same field names/types/required,
// `additionalProperties:false`), but FLAT — no outer metric key — to match AO's judge output + prompts + Zod
// (AO parses the object directly; cx-sqs's wrapper key is only its jsonKey extraction detail). Passed to
// `completeJSON` as `jsonSchema` with `strict:true` so the Vibe *responses* gateway forces exact JSON — without
// it the model can free-form → parse fail → eval_error. The generation writer already uses strict json_schema on
// the same gateway, so this is proven. This is NOT from the plugins folder (the SDK delegates output shaping to
// LiveKit's `_LLMJudge`); it's the cx-sqs construct. The 2 programmatic judges call no LLM and need no schema.
// Live-axis judge schemas (conversation/stt/td) are added when Phase 2 wires them.

type JsonSchema = Record<string, unknown>;

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const strArray = { type: "array", items: { type: "string" } } as const;
const arrayOf = (items: JsonSchema) => ({ type: "array", items });

/** An object schema with EVERY property required + additionalProperties:false (strict-mode requirement). */
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
  obj({ hallucinated: bool, score: num, reason: str, technical_reason: str }),
);

export const NODE_LOOP_JSON = strict(
  "eval_loop",
  obj({ loop_detected: bool, score: num, reason: str, technical_reason: str }),
);

export const VARIABLE_EXTRACTION_JSON = strict(
  "eval_variable",
  obj({
    extraction_successful: bool,
    score: num,
    reason: str,
    technical_reason: str,
    missing_variables: strArray,
    incorrect_variables: strArray,
  }),
);

export const INTENT_JSON = strict(
  "eval_intent",
  obj({ intent_not_found: bool, intent_wrongly_identified: bool, reason: str, technical_reason: str }),
);

// instruction adherence — the 4 sub-metrics (mirror cx-sqs node/instruction/config.go exactly).
const MISSED_STEP = obj({ step: str, severity: str, reason_code: str, details: str });
const ISSUE = obj({ category: str, reason_code: str, details: str });
export const INSTRUCTION_ADHERENCE_JSON = strict(
  "eval_instruction",
  obj({
    objective_progress: obj({ achieved: bool, score: num, reason_code: str, reason: str, technical_reason: str }),
    procedure_compliance: obj({ score: num, reason_code: str, missed_steps: arrayOf(MISSED_STEP), reason: str, technical_reason: str }),
    interaction_quality: obj({ score: num, reason_code: str, issues: arrayOf(ISSUE), reason: str, technical_reason: str }),
    policy_boundary_compliance: obj({ passed: bool, score: num, reason_code: str, reason: str, technical_reason: str }),
  }),
);

// ── goal judge ───────────────────────────────────────────────────────────────────
// AO uses the flat array shape (matching our GoalRawZ + OUT_GOAL prompt), not cx-sqs's per-goal-name keys.
export const GOAL_JSON = strict(
  "eval_goal",
  obj({ goals: arrayOf(obj({ goal_name: str, achieved: bool, reason: str, technical_reason: str })) }),
);
