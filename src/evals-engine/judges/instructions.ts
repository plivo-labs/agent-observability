// AO Eval Engine — judge prompts.
//
// LINEAGE: the criteria bodies started as verbatim copies of the OSS SDK's
// `_instructions.py` (a terse rewrite of the reference engine). That compression
// dropped the calibration the production cx-sqs Go evaluator spent cycles earning —
// the severity logic that stops adherence over-firing, the evidence-source list that
// stops hallucination false-positives, the leniency defaults, the score anchors, and
// the reason_code vocabularies. This file RE-INLINES that calibration (ported from
// `cx-sqs-worker/usecases/eval/prompts/**/*.tmpl`), trimmed but faithful.
//
// ANTI-OVER-FIRE INVARIANT: every judge below carries an explicit leniency default —
// when evidence is genuinely ambiguous, favor the PASS / not-detected / "minor"
// verdict. These defaults are the mechanism that keeps the judges from over-firing;
// do not remove them when editing.
//
// The SDK judges return LiveKit's thin `{verdict, reasoning}`. The console needs the
// reference engine's RICH struct (score + booleans + the 4 adherence sub-metrics). So
// each system prompt = a criteria body + an OUTPUT section WE author that requests
// exactly the raw-schema fields (validated by the judge's Zod). `{slot}` placeholders
// are filled with `fill()`.

/** Replace `{key}` placeholders. Mirrors Python `.format(**vars)` for our slotted prompts. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k]! : m));
}

/** Platform system intents. Sourced here (not buried in prose) so the set can be
 *  kept in step with the runtime rather than drifting inside a prompt string. */
export const SYSTEM_INTENTS = ["hangup", "error", "failed", "sent", "conversation_complete"] as const;

// ── criteria bodies ───────────────────────────────────────────────────────────────

export const HALLUCINATION = `Does the agent's response contain fabricated information not supported by any valid evidence source? Hallucination is ONLY about factual accuracy — NOT formatting, style, or instruction compliance.

Falsifiability test (apply FIRST to every statement): could a reasonable person show this statement is wrong by checking reality, the conversation, or the evidence? If NO — it is purely social/conventional (greeting, thanks, apology, offer of help, generic closing) — it is NOT hallucination, regardless of whether the instructions permitted it. Only falsifiable factual claims are subject to grounding.

Valid evidence sources (a claim traceable to ANY of these is grounded — this list is exhaustive):
1. Conversation history and the current transcript (anything actually said, User or Agent).
2. Tool/function call outputs (Tool_Call / Tool_Result lines) and KB passages (KB_Chunks lines, when present) — lossless paraphrase of a tool/KB result is grounded; only NEW specifics the source does not establish (quantities, dates, ids, prices, conditions) are hallucination.
3. The agent's instructions (node + global prompt).
4. EXTRACTED_VARIABLES (when present in the payload): a value the agent references that appears here came from context/previous nodes — NOT hallucination.
5. GLOBAL_VARIABLES (when present): runtime context the platform supplied (trigger inputs, mid-flow HTTP/tool outputs). A value that appears anywhere in this map is grounded even if it never shows in the transcript; a claim directly implied by this context is also grounded.
6. PRONUNCIATION_GUIDES (when present): a word→guide TTS map. The engine rewrites each word to its guide before speaking, so the guide form in the transcript is grounded by whatever grounds the original word — treat guide and word as equivalent.

Steps:
1. Identify every specific factual claim in the agent's messages (names, numbers, dates, statuses, policies).
2. For each claim, check it against ALL of the evidence sources above. A claim is hallucinated ONLY if it appears in NONE of them AND contradicts context.
3. NOT hallucination: opinions, apologies, offers to help, saying "I don't know", or referencing policies/variables from context.
4. NOT hallucination: process narration and forward commitments ("let me check", "I'll look into that", "we'll get that scheduled") — promises of action are not factual claims. They become hallucination only when the agent then asserts a specific fabricated RESULT (e.g. states a slot was verified/booked when no evidence shows it).
5. NOT hallucination: unrendered template placeholders (e.g. {name}, {{appointment_time}}) appearing in instructions or transcript — those are rendering artifacts, not fabricated facts.
6. NOT hallucination: runtime context the platform injects (the current date/time/day-of-week, the caller's name or number, account or session parameters) — flag a date/identity claim only when it CONTRADICTS the conversation or tool evidence.
6a. USER ECHO IS GROUNDED: a value the USER stated — in any spoken form — that the agent repeats back or confirms is grounded by the user's own words, in ANY equivalent rendering: spoken-number/date words vs numerals vs resolved calendar form ("July third twenty twenty-six" ≡ "July 3rd, 2026" ≡ 2026-07-03; "twenty twenty-six" spoken as "20 26" is the YEAR 2026, not a day). Addressing the caller by a name they gave is grounded. Verify against the user's actual words FIRST, before any other source.
6b. HINT LINES ARE AIDS, NOT ARBITERS: date-hint / preprocessor System_Note lines are supplementary parsing aids and are NOT exhaustive. When a hint line's parse conflicts with what the user plainly said, the user's words win. The ABSENCE of a hint entry for a user-stated value, or a hint that mis-parsed it, NEVER makes the agent's faithful read-back ungrounded.
7. Clarification behavior is NOT hallucination when the agent marks an ungrounded detail as tentative (asks to confirm) rather than asserting it as an established fact.
8. Lines labelled System_Note: or Agent_Handoff: are internal runtime events, not factual claims the agent made to the user — never treat them as assertions requiring grounding.

Pass if all claims are supported. Fail if any critical fact is fabricated. Maybe if there are minor unsupported details that don't change the meaning.

When ambiguous, favor hallucinated=false — only fire when the agent presents an unsupported detail as established/resolved/known.`;

export const VARIABLE_EXTRACTION = `Were the agent's extracted variables correct? Each extracted variable must (1) be in the variables-to-extract list and (2) have a value grounded in the context. This metric judges ONLY the stored values — NOT how the agent spoke, read back, phrased, or formatted anything, NOT wording/sequencing constraints, NOT tone or naturalness. If a required variable's stored value is correct, extraction_successful=true regardless of any other behavior.

Variables expected to be extracted (allowed names, with each variable's recording/format rule):
{expected_variables}

Variables the agent actually extracted:
{actual_variables}

Steps:
1. For each entry in actual variables: does the name appear in the expected list? If not, fail (extra variables).
2. For each extracted value: can the value be found in the conversation or provided data? Fabricated values should be penalized.
3. Was any expected variable's value available in the context but NOT extracted? That's a critical miss (add to missing_variables).
4. Omitting a variable is OK if its value is truly not available in context (user went idle, declined, or never provided it).
5. Conditional variables: when a variable's recording rule says to leave it empty unless a condition happens (e.g. "record only once the caller explicitly confirms"), its absence is CORRECT behavior when that condition never occurred — do not count it as missing.
6. Context-supplied values are NOT "missed": a value the platform already provided as runtime/global context or an initial parameter (e.g. a caller phone number, account id) that the user did NOT state during this node is not something the agent failed to extract — do not mark it missing. Judge only variables the user actually supplied in this node's conversation.

Normalization is EXPECTED and NOT an error — a value is correct when it represents the same underlying information even in a different form:
- Spoken digits → compact form ("one two three" → "123").
- Spoken dates → calendar form: "July twenty fourth" → 2026-07-24; a spoken year like "twenty twenty-six" or "20 26" is the YEAR 2026. Check the stored value against the USER'S OWN WORDS first — when it matches any reasonable reading of what the user said (and confirmed), it is CORRECT.
- Standard reformatting (dates, phone numbers, codes), abbreviations vs full forms.
- Values computed per the variable's rule (relative dates resolved to calendar dates, time-of-day mapped per the rule) or resolved via the platform's date-hint context ("today"/"next week" → the hinted calendar date).
Hint/preprocessor lines are parsing aids, not arbiters: never mark a value incorrect solely because a hint line parsed the user's words differently — the transcript is the primary source.
Mark INCORRECT only when the value is garbage/malformed, semantically WRONG (different date/number/name), truncated beyond recognition, or contradicts what the user conveyed AND is not justified by the rule.

Score: 1.0 all correct | 0.75 minor issues | 0.5 notable gaps | 0.25 most missing/incorrect | 0.0 complete failure.

Pass if all extracted variables are valid and grounded. Fail for extra or fabricated variables, or a required value that was provided but missing/wrong. Maybe for minor issues.

When ambiguous, favor extraction_successful=true if the values are approximately correct. This leniency applies to VALUE disputes only — never to omissions: an EMPTY extraction set is not automatically a pass. When the user clearly STATED a value for an expected variable during this node's conversation (including an explicit enum condition being met) and nothing was stored, that is a real failure — list it in missing_variables and fail. This omission rule inherits steps 4-6 unchanged: values the user never stated, conditional variables whose condition never occurred, and context/platform-supplied values (step 6) are still NOT misses.`;

export const LOOP_DETECTION = `Does the agent inappropriately repeat its own previous messages without justification? Loops indicate the agent is stuck — the conversation stays on the SAME step instead of advancing to the next.

Steps:
1. Scan ALL agent messages in the node transcript, in order — a loop can occur anywhere in the node, not only at the end.
2. Flag any run of 2 or more agent messages that are substantially identical in content or intent (same substantive question or information restated) where the conversation did NOT advance to the next logical step.
3. Ignore lines labelled Tool_Call:, Tool_Result:, System_Note:, or Agent_Handoff: — those are internal events, not agent speech.
4. Repetition is justified when new user input, a mishear/no-response, an error, or a legitimate return to an earlier step explains it. Progress means the agent USED the user's answer and moved on — not merely that the user eventually answered.

NOT a loop (these must never fire):
- Idle re-engagement: repeated prompts while the user is silent/inactive are appropriate responses to inactivity, not loops. Turns marked [system idle prompt] are platform scaffolding — exclude them entirely.
- Unmarked idle scaffolding: a verbatim-identical short check-in line repeated 2-3 times into silence with NO user speech between ("Are you still there?"-style re-engagement), optionally followed by a scripted disconnect line, is the platform's idle timer re-speaking a configured reminder — exclude these runs even when no [system idle prompt] tag is present. This exemption covers only the check-in/re-prompt/disconnect register: an agent repeating SUBSTANTIVE task content into dead air (re-asserting information, re-running a step) is still a loop.
- A single interrupted restart, or one/two restarts after an interruption when the agent then advances.
- Greetings, sign-offs, and short acknowledgements ("Got it", "Sure", "How can I help?") repeating.
- Re-asking for the same information because the user has not yet provided it (no answer, silence, an off-topic reply, or a mishear) is a justified re-ask, not a loop — only flag when the user ALREADY gave a usable answer and the agent asks for it again anyway.

Score: 1.0 no repetition OR single repetition then clear progress | 0.75 brief repetition then recovers | 0.5 extended repetition that eventually resolves | 0.25 severe repetition, minimal progress | 0.0 completely stuck. loop_detected=true when score < 0.5.

Pass if no unjustified repetition exists. Fail only for unjustified repetition of the same substantive step after the user already gave enough to move forward.

When ambiguous, favor loop_detected=false — a single repetition with recovery is not a loop.`;

export const INSTRUCTION_ADHERENCE = `Evaluate whether the agent followed its instructions for this node. Use the four-part rubric: objective_progress, procedure_compliance, interaction_quality, and policy_boundary_compliance. Evaluate each sub-dimension independently. Same evidence must always yield the same verdict.

Agent instructions:
{instructions}

Optional scenario objective:
{objective}

SCOPE — these belong to OTHER judges, never fail adherence for them:
- Whether the right intent fired → intent judge. - Whether variables were captured → variable judge. - Whether a fact was fabricated → hallucination judge. Call lifecycle (hanging up, transitions, routing) is outside the agent's control.

TRANSCRIPT NOTE — internal event lines are NOT agent speech: lines labelled Tool_Call:, Tool_Result:, System_Note:, or Agent_Handoff: are runtime events rendered only for context. They are NOT words the agent said to the user. Never fail adherence because such a line appears — they do not count as revealing internals, speaking during a silent/seamless handoff, breaking turn shape, or "combining tool calls into a turn". Judge procedure and policy ONLY from the agent's actual spoken messages.

SILENT RECORDING TOOLS: variable-recorder / bookkeeping tool calls (record_*, set/extract-variable style writes) are silent background operations by design. NEVER treat one as a missed step or violation because it fired without spoken acknowledgment, without being announced, or detached from a spoken turn — announcing an internal recording would itself violate "never reveal internals". Instructions about speaking around tool use apply only to user-facing waits (lookups, holds, transfers), not to recording writes. The ORDER or PLACEMENT of recording calls in the transcript is a serialization artifact, never a procedure step. This exempts the tool call ONLY: a separately-instructed spoken confirmation or read-back to the caller ("confirm the date back") is still a real procedure step, judged from the agent's spoken messages as usual.

INTERRUPTED TURNS: an agent turn tagged [interrupted] was cut off by the caller or by call end — judge only what was delivered; never penalize the missing remainder (a cut-off greeting is not a skipped greeting). Steps the agent never reached because the call ended, the user hung up, or an interruption cut the flow are UNREACHABLE, not missed — this includes a call whose only agent turn is an interrupted opening. Turns tagged [system idle prompt] are platform boilerplate, not agent speech — never count them for procedure or interaction_quality (not a repeated question, not multi_question, not robotic).

TRANSFER SEMANTICS: "immediately transfer when the caller asks for a human"-style rules apply ONLY to caller-initiated requests. When the AGENT offered a specialist/transfer and the caller accepted or declined, the immediate-transfer rule is not in play — do not fail the agent for speaking around an offered transfer or for not transferring when the caller declined the offer.

FUNCTIONAL COMPLETION TEST (FCT) — the core anti-over-fire rule. Every step has an OBJECTIVE (the outcome: confirm date, collect name, verify identity) and CONSTRAINTS (how to say it: exact wording, order). When the objective was achieved AND the user understood/responded appropriately, the step is functionally complete, and any constraint deviation is "minor" severity — NEVER "critical" — regardless of NEVER/ALWAYS/MUST language in the instructions. A step is only "critical" when its objective was not achieved at all. Accept semantically equivalent wording, alternative phrasings, reordered or combined steps, and self-corrections. For confirmations, ANY clear affirmative in context ("yes", "okay", "sure", "sounds good") is agreement obtained.

Sub-dimensions:
1. objective_progress (achieved: boolean, score): did the agent pursue this node's main objective and make reasonable progress? achieved=true even if the user went idle/refused/was interrupted, as long as the agent did what was in its control. achieved=false only when it failed to pursue the goal, abandoned it without external cause, or pursued the wrong goal. reason_code ∈ {goal_achieved, no_substantive_progress, abandoned_goal, wrong_goal}.
2. procedure_compliance (score, missed_steps[]): were MANDATORY steps executed? A step is not "missed" if it was unreachable (an intent transition fired, a system interruption cut the call, the user refused/went idle). For each genuinely missed step set severity via the gating question: was the step's outcome achieved in some form? YES → "minor" at most, stop. NO → "critical" only if the step exists to verify identity, obtain consent, deliver a legal/regulatory disclosure, protect safety, or route to the correct channel; otherwise "minor". These are NEVER critical: skipped/short greeting when the task still happened, different wording/format for correctly conveyed info, paraphrased required statements, non-scripted but professional closings. per-step reason_code ∈ {missed_verification, missed_consent, missed_disclosure, missed_required_question, wrong_sequence, other_procedure_gap}; bucket reason_code ∈ {procedure_followed, no_required_steps, minor_step_gaps, critical_step_missed}. If the instructions define no mandatory steps → score 1.0, missed_steps [], reason_code no_required_steps.
3. interaction_quality (score, issues[]): clarity, one-question-at-a-time, acknowledgement, tone, naturalness. Quality only — no pass/fail. issue category ∈ {multi_question, missing_acknowledgment, unclear_response, tone_deviation, robotic_response, other}; bucket reason_code ∈ {no_quality_issues, minor_quality_issues, notable_quality_issues, severe_quality_issues}.
4. policy_boundary_compliance (passed: boolean, score): were explicit scope/escalation/handoff/confidentiality boundaries respected? A violation requires the AGENT ITSELF to cross a boundary (disclosed protected info, answered a clearly out-of-scope topic it was told to defer, behaved inappropriately). Style drift is interaction_quality, not policy. reason_code ∈ {boundary_respected, out_of_scope_no_deferral, handoff_violation, confidentiality_violation, inappropriate_behavior, other_boundary_violation}. passed=false when any violation is found.

Score anchors for every sub-dimension: 1.0 excellent | 0.75 minor issues, no impact | 0.5 partial/notable but functional | 0.25 substantially degraded | 0.0 failed entirely.

When evidence is ambiguous, apply the principle of charity: if the agent's behavior can reasonably be read as following instructions, do not penalize; if the objective was met and the user was not confused or harmed, constraint deviations are "minor" at most, never "critical".`;

export const INTENT_IDENTIFICATION = `Evaluate whether the agent/framework selected the correct intent for the conversation segment. Judge ONLY whether the chosen intent matches the user's expressed intention — response quality is out of scope. Interpret intent instructions SEMANTICALLY and contextually, not by literal word-match.

Available intents:
{available_intents}

System intents (never a failure):
{system_intents}

Chosen intent:
{chosen_intent}

Evaluation order (stop at the first that applies):
1. If the chosen intent is a system intent (in the list above) → intent_not_found=false AND intent_wrongly_identified=false. Stop.
2. If there is no user input, or the chosen intent is null/empty/"(none)" → the framework did not RECORD one; that is NOT a wrong identification. Judge from the conversation and Tool_Call/handoff evidence: set intent_wrongly_identified=true ONLY when the evidence shows an intent that contradicts the user's actual request, and intent_not_found=true ONLY when the user expressed a clear need absent from the available list. Otherwise both false. Stop.
3. If the chosen intent is not in the available list → intent_not_found=true, intent_wrongly_identified=false. Stop.
4. Context establishment: if the intent presupposes that the agent asked a specific question or made a specific statement, verify that prerequisite was ACTUALLY delivered as a complete, comprehensible message in the transcript (or conversation history). An incomplete/cut-off message does NOT count — do not infer it from the node name or instructions. If the prerequisite was required but never delivered → intent_wrongly_identified=true.
5. Semantic match: does the user's message satisfy the intent's conditions? Acknowledgment = appropriate response — when an intent mentions "acknowledges"/"responds", any appropriate reply to the agent's question IS an acknowledgment regardless of the exact words. Examples after "OR" in an intent's instructions are illustrative, not required wording. If satisfied → both false; if not → intent_wrongly_identified=true.

intent_not_found and intent_wrongly_identified are mutually exclusive.

Pass when the chosen intent is supported and correct. Fail when not found or wrongly identified. Maybe when the user input is ambiguous.

When ambiguous (and context was established in step 4), favor the framework's chosen intent if the user's response could reasonably satisfy its conditions.`;

export const GOAL_EVALUATION = `Evaluate whether the configured goals were achieved by the conversation.

Goals:
{goals}

Flow/run history or additional context:
{flow_history}

Rules:
1. Evidence-based: mark a goal achieved only with clear evidence in the history; do not infer or assume outcomes not shown.
2. Complete achievement required: partial achievement = NOT achieved. If a goal needs 3 pieces of information and only 2 were collected, it is not achieved.
3. All evidence counts: consider every node execution present in the history — conversation turns, tool/function results, HTTP results, branch decisions, call forwards, template sends — not just what was said.
4. The goal's instructions are the criteria; evaluate strictly against them.
5. Respond in English regardless of the transcript language.

For each goal, decide whether the conversation achieved it. Pass when all required goals were achieved. Fail when any required goal was clearly missed. Maybe when the transcript lacks enough evidence.

Early termination by user: if the user's intent or action clearly satisfies a goal's core criteria but the conversation ends abruptly (e.g. the chosen intent is "hangup") before the agent can complete follow-up actions like confirming, acknowledging, or closing, mark the goal as achieved. The agent cannot control when the user terminates — judge whether the goal's substantive outcome was reached, not whether every procedural step afterward completed.

Conditional goals — NOT APPLICABLE is NOT a failure: when a goal's own instructions define a triggering condition (e.g. "if the caller asks for a human…", "when the user disputes…") and that condition never occurred in the conversation, the goal does not apply. Mark it achieved=true and state "not applicable — the triggering condition never occurred" in the reason. NEVER mark a conditional goal not-achieved solely because its trigger never arose — that penalizes the agent for a non-event.{sim_rules}`;

// Simulation-only rules (cx-sqs goal user.tmpl {{if .IsSimulation}} block). A sim
// transcript is a replay that omits some non-dialogue node logs, so the judge must
// not penalize missing downstream logs and may treat a terminal compliance intent
// as a success proxy. Appended to GOAL_EVALUATION only on the simulation eval path;
// the live goals feature evaluates real sessions and leaves this empty.
const GOAL_SIM_RULES = `

===== SIMULATION CONTEXT =====
This transcript is generated from a simulation replay and may omit explicit logs for some non-dialogue nodes (for example HTTP/action side effects, branch execution details, call-forward metadata, template send receipts).

Evaluation rules for simulation:
1. Use only evidence present in this transcript (messages, extracted variables, chosen intents).
2. Do NOT automatically mark achieved=false only because downstream non-dialogue node logs are missing.
3. Do NOT assume unseen side effects; infer only from the strongest upstream conversational evidence.
4. Success proxy rule: if the chosen intent indicates a terminal compliance outcome (for example "User Opt Out") and there is no contradictory evidence, treat the matching compliance goal as achieved in simulation.
5. Contradictory evidence includes explicit refusal to comply, explicit opposite action, or explicit non-completion.
6. If evidence is genuinely insufficient, mark achieved=false and clearly state "insufficient simulation evidence" in technical_reason.
7. When using the success proxy rule, explicitly mention the proxy basis in technical_reason.`;

// ── output-format sections (authored to request the rich fields the console contract needs) ──────────

const OUT_HALLUCINATION = `Return ONLY a JSON object (score bands: 1.0 every claim grounded | 0.75 minor details not fully traceable, core grounded | 0.5 mix of grounded/ungrounded | 0.25 significant ungrounded | 0.0 entirely ungrounded):
{"hallucinated": boolean, "score": number (0.0-1.0, where 1.0 = fully grounded, no hallucination), "reason": string (concise, user-facing), "technical_reason": string (detailed evidence trace)}`;

const OUT_VARIABLE = `Return ONLY a JSON object (missing_variables = required variables the user provided but the agent did NOT extract; incorrect_variables = variables the agent extracted with a wrong or ungrounded value; use the exact variable names; empty arrays if none):
{"extraction_successful": boolean, "score": number (0.0-1.0, where 1.0 = all required variables correctly extracted), "reason": string, "technical_reason": string, "missing_variables": [string], "incorrect_variables": [string]}`;

const OUT_LOOP = `Return ONLY a JSON object:
{"loop_detected": boolean, "score": number (0.0-1.0, where 1.0 = no unjustified repetition), "reason": string, "technical_reason": string}`;

const OUT_INSTRUCTION = `Return ONLY a JSON object with the four sub-metrics (do NOT return a top-level pass/fail — that is computed by the caller). Use ONLY the reason_code / severity / category values enumerated in the rubric above; score is 0.0-1.0 per the anchors:
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
  compose(
    fill(INTENT_IDENTIFICATION, {
      available_intents: availableIntents,
      chosen_intent: chosenIntent,
      system_intents: SYSTEM_INTENTS.join(", "),
    }),
    OUT_INTENT,
  );

export const systemForGoal = (goals: string, flowHistory: string, isSimulation = false): string =>
  compose(
    fill(GOAL_EVALUATION, { goals, flow_history: flowHistory, sim_rules: isSimulation ? GOAL_SIM_RULES : "" }),
    OUT_GOAL,
  );
