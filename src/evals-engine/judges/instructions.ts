// AO Eval Engine — judge prompts.
//
// The CRITERIA bodies below are ported VERBATIM (wording-for-wording) from the OSS SDK's
// `plugins/agent-observability-sdk/.../judges/_instructions.py` (line-wrapping unfolded — the Python
// `\`-continuations join lines with a single space; the words are identical). Those criteria are
// themselves a faithful port of cx-sqs's MetricPromptConfig, so behavior matches the production engine
// while the source stays open-source.
//
// The SDK judges return LiveKit's thin `{verdict, reasoning}`. The console needs cx-sqs's RICH struct
// (score + booleans + the 4 adherence sub-metrics). So each system prompt = the SDK criteria body + an
// OUTPUT section WE author that requests exactly the raw-schema fields (validated by the judge's Zod).
// `{slot}` placeholders are filled with `fill()`.
//
// PARITY ANCHOR: to check we didn't drift, diff the CRITERIA constants here against `_instructions.py`.

/** Replace `{key}` placeholders. Mirrors Python `.format(**vars)` for our slotted prompts. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k]! : m));
}

// ── criteria bodies (verbatim from _instructions.py) ──────────────────────────────

export const HALLUCINATION = `Does the agent's response contain fabricated information not supported by any valid evidence source? Hallucination is ONLY about factual accuracy — NOT formatting, style, or instruction compliance.

Steps:
1. Identify every specific factual claim in the agent's messages (names, numbers, dates, statuses, policies).
2. For each claim, check valid evidence sources: the conversation history, function call outputs, and the agent's instructions.
3. A claim is hallucinated ONLY if it appears in NONE of those sources AND contradicts context.
4. NOT hallucination: opinions, apologies, offers to help, saying "I don't know", or referencing policies/variables from context.

Pass if all claims are supported. Fail if any critical fact is fabricated. Maybe if there are minor unsupported details that don't change the meaning.`;

export const VARIABLE_EXTRACTION = `Were the agent's extracted variables correct? Each extracted variable must (1) be in the variables-to-extract list and (2) have a value grounded in the context.

Variables expected to be extracted (allowed names):
{expected_variables}

Variables the agent actually extracted:
{actual_variables}

Steps:
1. For each entry in actual variables: does the name appear in the expected list? If not, fail (extra variables).
2. For each extracted value: can the value be found in the conversation or provided data? Fabricated values should be penalized.
3. Was any expected variable's value available in the context but NOT extracted? That's a critical miss.
4. Omitting a variable is OK if its value is truly not available in context.

Pass if all extracted variables are valid and grounded. Fail for extra or fabricated variables. Maybe for minor issues.`;

export const LOOP_DETECTION = `Does the agent inappropriately repeat its own previous messages without justification? Loops indicate the agent is stuck.

Steps:
1. Look at the agent's most recent message.
2. Compare it to the last 2–3 prior agent messages in the conversation.
3. Is the latest message substantially identical to a recent one?
4. If similar, does new user input or new context justify repeating?

Pass if the message is new or repetition is justified. Fail for unjustified repetition of the same substantive question or information. Greetings, sign-offs, and short acknowledgements ("Got it", "Sure", "How can I help?") are allowed to repeat.`;

export const INSTRUCTION_ADHERENCE = `Evaluate whether the agent followed its instructions for this scenario. Use the cx-style four-part rubric: objective_progress, procedure_compliance, interaction_quality, and policy_boundary_compliance.

Agent instructions:
{instructions}

Optional scenario objective:
{objective}

Rubric:
1. Objective progress: did the agent move toward the intended task outcome?
2. Procedure compliance: did it follow mandatory steps, confirmations, and ordering constraints?
3. Interaction quality: was it clear, professional, not overloaded, and responsive to the user?
4. Policy boundary compliance: did it avoid unsafe, forbidden, or out-of-scope behavior?

Pass only when objective, procedure, and policy are satisfied. Maybe for minor interaction quality issues that do not change the outcome. Fail for critical missed steps, objective failure, or policy violation.`;

export const INTENT_IDENTIFICATION = `Evaluate whether the agent/framework selected the correct intent for the conversation segment.

Available intents:
{available_intents}

Chosen intent:
{chosen_intent}

Rules:
1. intent_not_found=true when the user's intent is valid but not represented in the available intent list.
2. intent_wrongly_identified=true when the chosen intent does not match the user's actual request.
3. System intents such as hangup, error, failed, sent, or conversation_complete are acceptable when they match a system interruption.

Pass when the chosen intent is supported and correct. Fail when not found or wrongly identified. Maybe when the user input is ambiguous.`;

export const GOAL_EVALUATION = `Evaluate whether the configured goals were achieved by the conversation.

Goals:
{goals}

Flow/run history or additional context:
{flow_history}

For each goal, decide whether the conversation achieved it. Pass when all required goals were achieved. Fail when any required goal was clearly missed. Maybe when the transcript lacks enough evidence.`;

// ── output-format sections (authored to request the rich fields the console contract needs) ──────────

const OUT_HALLUCINATION = `Return ONLY a JSON object:
{"hallucinated": boolean, "score": number (0.0-1.0, where 1.0 = fully grounded, no hallucination), "reason": string (concise, user-facing), "technical_reason": string (detailed evidence trace)}`;

const OUT_VARIABLE = `Return ONLY a JSON object (missing_variables = required variables the user provided but the agent did NOT extract; incorrect_variables = variables the agent extracted with a wrong or ungrounded value; use the exact variable names; empty arrays if none):
{"extraction_successful": boolean, "score": number (0.0-1.0, where 1.0 = all required variables correctly extracted), "reason": string, "technical_reason": string, "missing_variables": [string], "incorrect_variables": [string]}`;

const OUT_LOOP = `Return ONLY a JSON object:
{"loop_detected": boolean, "score": number (0.0-1.0, where 1.0 = no unjustified repetition), "reason": string, "technical_reason": string}`;

const OUT_INSTRUCTION = `Return ONLY a JSON object with the four sub-metrics (do NOT return a top-level pass/fail — that is computed by the caller):
{
  "objective_progress": {"achieved": boolean, "score": number (0.0-1.0), "reason_code": string, "reason": string, "technical_reason": string},
  "procedure_compliance": {"score": number (0.0-1.0), "reason_code": string, "missed_steps": [{"step": string, "severity": "critical"|"minor", "reason_code": string, "details": string}], "reason": string, "technical_reason": string},
  "interaction_quality": {"score": number (0.0-1.0), "reason_code": string, "issues": [{"category": string, "reason_code": string, "details": string}], "reason": string, "technical_reason": string},
  "policy_boundary_compliance": {"passed": boolean, "score": number (0.0-1.0), "reason_code": string, "reason": string, "technical_reason": string}
}`;

const OUT_INTENT = `Return ONLY a JSON object (do NOT return a score — the caller derives it):
{"intent_not_found": boolean, "intent_wrongly_identified": boolean, "reason": string, "technical_reason": string}`;

const OUT_GOAL = `Return ONLY a JSON object with one entry per goal (use the exact goal_name given):
{"goals": [{"goal_name": string, "achieved": boolean, "reason": string, "technical_reason": string}]}`;

// ── composed system prompts (criteria body + output section) ───────────────────────

const compose = (body: string, output: string) => `${body}\n\n${output}`;

export const systemForHallucination = (): string => compose(HALLUCINATION, OUT_HALLUCINATION);
export const systemForLoop = (): string => compose(LOOP_DETECTION, OUT_LOOP);

export const systemForVariableExtraction = (expectedVariables: string, actualVariables: string): string =>
  compose(fill(VARIABLE_EXTRACTION, { expected_variables: expectedVariables, actual_variables: actualVariables }), OUT_VARIABLE);

export const systemForInstructionAdherence = (instructions: string, objective: string): string =>
  compose(fill(INSTRUCTION_ADHERENCE, { instructions, objective }), OUT_INSTRUCTION);

export const systemForIntent = (availableIntents: string, chosenIntent: string): string =>
  compose(fill(INTENT_IDENTIFICATION, { available_intents: availableIntents, chosen_intent: chosenIntent }), OUT_INTENT);

export const systemForGoal = (goals: string, flowHistory: string): string =>
  compose(fill(GOAL_EVALUATION, { goals, flow_history: flowHistory }), OUT_GOAL);
