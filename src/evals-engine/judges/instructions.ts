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

CANDIDATE CLAIMS — SPOKEN AGENT LINES ONLY:
Only text from actual \`Agent:\` speech lines can be an accusation target. Lines labelled \`Tool_Call:\`, \`Tool_Result:\`, \`System_Note:\`, or \`Agent_Handoff:\` are internal runtime events, not words the caller heard; they are NEVER accusation targets, even if malformed or legacy input placed an \`Agent:\` prefix before their label. This rule is deliberately asymmetric: runtime-event lines remain valid grounding EVIDENCE for claims in spoken agent lines. If no spoken line contains a falsifiable factual claim, return hallucinated=false immediately.

SCOPE — OTHER JUDGES:
- Whether a statement was forbidden, premature, or unauthorized belongs to instruction adherence. This metric asks whether the spoken content is grounded, not whether the agent was allowed to say it. A prohibited statement can be perfectly grounded.
- Wrong or invented values that appear only in stored data (tool arguments or extracted variables) belong to variable extraction. Do not turn bookkeeping data into a spoken hallucination.
- A misread or misattribution of the user's words belongs to instruction adherence or variable extraction when the user's actual turn plausibly supports the mistaken reading. This does not excuse an agent claim with no plausible support anywhere.
- Applying a configured criterion to a caller-proposed scenario belongs to instruction adherence when the scenario plausibly satisfies that criterion (for example, accepting the caller's proposed room as meeting a configured space requirement). The hallucination judge must not re-grade whether the instructions allowed the agent to make that suitability decision. A new specific property of the scenario that appears nowhere in the evidence is still hallucination.
- Whether an objective was completed, a step was skipped, or the right intent fired belongs to goal, adherence, or intent evaluation.

Falsifiability test (apply FIRST to every statement): could a reasonable person show this statement is wrong by checking reality, the conversation, or the evidence? If NO — it is NOT hallucination, regardless of whether the instructions permitted it. Only falsifiable factual claims are subject to grounding.
- Social or conventional language (greetings, thanks, apologies, offers of help, and generic closings) asserts no checkable fact.
- IMPERATIVES, recommendations, and suggestions ("try updating the app", "check your confirmation email") assert no outcome by themselves. Do not judge whether an imperative's advice is correct or supported, and never reconstruct an implied promise that following it will work. Only a separately and explicitly stated factual premise or predicted result is a candidate claim.
- Generic reassurance carrying no specific factual detail—no number, URL, named channel, hour, price, date, status, or outcome—is not a factual claim.
- Questions and tentative confirmations are not established assertions unless their wording independently states a fact.
Quote the agent's exact words before judging them. If no spoken words assert the alleged fact, there is no hallucination claim to charge.

Valid evidence sources (a claim traceable to ANY of these is grounded — this list is exhaustive):
1. Conversation history and the current transcript (anything actually said, User or Agent).
2. Tool/function call outputs (Tool_Call / Tool_Result lines) and KB passages (KB_Chunks lines, when present) — lossless paraphrase of a tool/KB result is grounded; only NEW specifics the source does not establish (quantities, dates, ids, prices, conditions) are hallucination.
3. The agent's instructions (node_prompt + global_prompt), including Initial Context / lead-input blocks, scripted step bodies, approved openings and definitions, price or option lists, forward-number tables, configured persona details, and mandated scope statements. A verbatim or faithful rendering of configured content is grounded even when saying it at that moment would violate an instruction; timing and permission belong to adherence.
4. EXTRACTED_VARIABLES (when present in the payload): a value the agent references that appears here came from context/previous nodes — NOT hallucination.
5. GLOBAL_VARIABLES (when present): runtime context the platform supplied (trigger inputs, mid-flow HTTP/tool outputs). A value that appears anywhere in this map is grounded even if it never shows in the transcript; a claim directly implied by this context is also grounded.
6. PRONUNCIATION_GUIDES (when present): a word→guide TTS map. The engine rewrites each word to its guide before speaking, so the guide form in the transcript is grounded by whatever grounds the original word — treat guide and word as equivalent.

EVIDENCE SEARCH — REQUIRED BEFORE FAILING:
The node_prompt and global_prompt can be long. Search the node instructions for the specific name, number, date, status, price, policy, or distinctive phrase and inspect nearby context; do not assume a fact is unsupported merely because it was not said by the user. Explicitly inspect any # Initial Context block and scripted STEP content. Then check conversation history, Tool_Call / Tool_Result and KB evidence, EXTRACTED_VARIABLES, GLOBAL_VARIABLES, and PRONUNCIATION_GUIDES. A tool result or configured context can ground spoken words even though the runtime-event line is not itself an accusation target.

HARD GROUNDING GATE: if ANY valid evidence source contains or directly implies the spoken claim, that claim is grounded and MUST NOT produce hallucinated=true. The evidence did not need to be spoken to, explained to, or confirmed by the caller first. Do not acknowledge that a source grounds a claim and then fail it for being undisclosed, overconfident, forbidden, or premature; those are instruction-adherence concerns.

Steps:
1. From actual spoken Agent: lines only, identify every specific falsifiable factual claim (names, numbers, dates, statuses, policies). Record the exact words; never reconstruct an implied claim.
1a. Remove any candidate that is only an imperative, recommendation, or troubleshooting suggestion and contains no separately stated result. Do not search for proof that the advice will work. For example, "if the tab is missing, update the app and log in again" recommends actions but does not assert that updating will restore the tab.
2. For each candidate, complete the evidence search above. A claim is hallucinated ONLY if it appears in NONE of the evidence sources AND contradicts context. If any source grounds it, stop evaluating that claim as hallucination.
3. NOT hallucination: opinions, apologies, offers to help, saying "I don't know", or referencing policies/variables from context.
4. Process narration ("let me check", "I'll look into that") is not a factual result. A forward commitment is grounded when an instruction, offered tool/handoff path, or successful action establishes that the agent or organization can perform it; do not require the future action to have happened already. But a definite promise to perform a concrete, externally verifiable action (send a WhatsApp link, call back with unavailable information, share results later) asserts that the capability/path exists. It IS hallucination when no instruction, tool/handoff, action result, or other valid source establishes that path. A successful non-recording action result that accepts/submits a lead, booking, callback, or follow-up request establishes the corresponding operational path; over-certainty about when a human will act is then an adherence issue, not a fabricated capability. A bookkeeping record_* call alone does NOT establish that any downstream action will happen.
5. NOT hallucination: unrendered template placeholders appearing in instructions, transcript, or tool arguments — these are substitution artifacts, not fabricated facts. This covers {name}, {{appointment_time}}, <fill_your_data>, [customer_name], %order_id%, $variable, and bare slot identifiers that clearly match configured variable names (confirmed_lead_name, lead_name, your_data). A placeholder spoken aloud is a rendering/adherence defect, not an invented real-world value. Do not exempt a genuine name, SKU, or code merely because it resembles an identifier.
6. NOT hallucination: runtime context the platform injects (the current date/time/day-of-week, the caller's name or number, account or session parameters) — flag a date/identity claim only when it CONTRADICTS the conversation or tool evidence. A caller_number grounds the same phone digits after ordinary presentation normalization: removing a country-code prefix, SIP wrapper, spaces, or punctuation does not create a new number.
6a. USER ECHO IS GROUNDED: a value the USER stated — in any spoken form — that the agent repeats back or confirms is grounded by the user's own words, in ANY equivalent rendering: spoken-number/date words vs numerals vs resolved calendar form ("July third twenty twenty-six" ≡ "July 3rd, 2026" ≡ 2026-07-03; "twenty twenty-six" spoken as "20 26" is the YEAR 2026, not a day). Addressing the caller by a name they gave is grounded. Verify against the user's actual words FIRST, before any other source.
6b. HINT LINES ARE AIDS, NOT ARBITERS: date-hint / preprocessor System_Note lines are supplementary parsing aids and are NOT exhaustive. When a hint line's parse conflicts with what the user plainly said, the user's words win. The ABSENCE of a hint entry for a user-stated value, or a hint that mis-parsed it, NEVER makes the agent's faithful read-back ungrounded.
7. Clarification behavior is NOT hallucination when the agent marks an ungrounded detail as tentative (asks to confirm) rather than asserting it as an established fact.
8. Lines labelled Tool_Call:, Tool_Result:, System_Note:, or Agent_Handoff: are internal runtime events, not factual claims the agent made to the user — never treat their contents or arguments as assertions requiring grounding. They remain evidence that can ground actual spoken claims.

For hallucinated=true, technical_reason MUST contain both labelled parts: Unsupported spoken claim: "<exact words from an Agent: speech line>"; Sources checked: "<which of sources 1-6 were checked and why none grounds the claim>". If either part is missing, return hallucinated=false. For hallucinated=false, state the decisive grounding or non-factuality rule concisely.

Pass if all claims are supported. Fail if any critical fact is fabricated. Maybe if there are minor unsupported details that don't change the meaning.

When ambiguous, favor hallucinated=false — only fire when the agent presents an unsupported detail as established/resolved/known.`;

export const VARIABLE_EXTRACTION = `Did the agent store every variable that was applicable to the path this call actually took, with correct values under each variable's own rule? This metric judges ONLY variable capture — NOT speaking, read-back, phrasing, sequencing, tone, workflow-label choice, or backend/platform data. Caller-capture values must be grounded in what the caller actually said; rule-produced values must be grounded in their recording rule and the active call path.

Variables expected to be extracted (allowed names, with each variable's recording/format rule):
{expected_variables}

Variables the agent actually extracted:
{actual_variables}

APPLICABILITY FIRST — decide what the call path required BEFORE comparing expected and actual variables:
A. Determine the active path from the conversation and node instructions: which steps and gates were reached, and whether the caller became not interested, busy/callback, wrong person, voicemail, or early termination/truncation.
B. Classify every expected variable from its OWN recording rule:
   - Caller-capture variables store a fact the caller supplies. They apply only when the relevant path/question was reached and the caller explicitly stated a value satisfying the rule.
   - Rule-produced variables store a default, summary, status, disposition, or mapped value the config itself directs. If stored, read the rule literally when checking the value. An absent rule-produced default or workflow field is never a missing caller variable: this judge detects lost caller information, not missing bookkeeping.
   - Platform/backend variables are runtime/global/initial values, backend identifiers, or tool/lookup results. They are not caller extraction and are never missing.
C. The expected-variable list is the configured surface and does NOT mean every variable is unconditionally required on every call. For example, when the caller becomes not interested before qualification, later qualification variables are INAPPLICABLE; do not demand values for questions or gates the call never reached. This includes a fallback no/default for an unreached busy or not-interested branch: its absence is not a missed caller fact.
D. Apply truncation before checking omissions. If the config schedules one final recording batch and the cutoff prevented the agent's next turn, that batch had no recording opportunity and none of its pending values are missing.

Steps:
1. For each entry in actual variables: does the name appear in the expected list? If not, fail (extra variables).
2. Evaluate each stored value by its class. For Caller-capture variables, compare it with the caller's own words. For Rule-produced variables, apply the variable's rule and active path literally; do not require the caller to utter a configured default, status, mapping, or summary. Fabricated caller-capture values should be penalized.
2a. Agent-composed fields are OUT OF SCOPE for this judge: summaries, remarks, outcome/status/disposition labels, language or interest classifications, and internal scores belong to instruction adherence or hallucination. NEVER place an agent-composed field in missing_variables or incorrect_variables, including workflow metadata inside a summary, even when that metadata conflicts with the transcript. This judge evaluates the caller variables captured from the applicable path, not the agent's authored narrative.
3. A caller-capture variable is missing ONLY when the caller EXPLICITLY STATED its value in that variable's own terms during this node, the variable was applicable on the active path, and the agent did not store it (add to missing_variables). "Available in the context" is NOT the test — being derivable is not being stated. Never add an absent default, summary, status, disposition, classification, internal score, or other rule-produced workflow field to missing_variables. These are NEVER misses:
   a. A value inferred, implied, derived, computed, bucketed, classified, or summarized from what the caller said rather than stated outright.
   b. A fact already captured under another expected variable; one statement only has to be stored once, never duplicated into a sibling or synonymous variable.
   c. A negative, empty, default, or not-applicable value for something that never happened or a topic that never arose.
   d. A variable from a flow step the call never reached or a gate that never opened. An unmet gate makes recording nothing CORRECT; it never creates a missing value.
4. TRUNCATED CALL OVERRIDE — BEFORE adding any missing_variable, check whether the transcript demonstrably ends mid-turn before the agent's configured end-of-call recording batch could run. The instruction "before any ending outcome or transfer" is a final-batch instruction. If an agent transfer/ending explanation was interrupted and the transcript then ends with a caller reply and no following agent or tool turn, treat it as truncated by definition: the agent never received the turn where the final batch and handoff would run. Set extraction_successful=true for those pending omissions and do NOT add them to missing_variables. Do not argue that the values could have been recorded earlier: when the config schedules one final batch, all values pending that batch are excused by the cutoff and missing_variables MUST be empty for that pending batch. This exception is narrow: A completed call that simply never recorded caller-stated values is a defect.
5. Conditional variables: when a variable's recording rule says to leave it empty unless a condition happens (e.g. "record only once the caller explicitly confirms"), its absence is CORRECT behavior when that condition never occurred — do not count it as missing.
6. Context-supplied values are NOT "missed": runtime/global/initial values, a backend identifier, or a value supplied by a platform action, tool or lookup result is not a caller extraction and must never be demanded merely because it appears in context.

Normalization is EXPECTED and NOT an error — a value is correct when it represents the same underlying information even in a different form:
- Spoken digits → compact form ("one two three" → "123").
- Spoken dates → calendar form: "July twenty fourth" → 2026-07-24; a spoken year like "twenty twenty-six" or "20 26" is the YEAR 2026. Check the stored value against the USER'S OWN WORDS first — when it matches any reasonable reading of what the user said (and confirmed), it is CORRECT.
- Standard reformatting (dates, phone numbers, codes), abbreviations vs full forms.
- Values computed per the variable's rule (relative dates resolved to calendar dates, time-of-day mapped per the rule) or resolved via the platform's date-hint context ("today"/"next week" → the hinted calendar date).
Hint/preprocessor lines are parsing aids, not arbiters: never mark a value incorrect solely because a hint line parsed the user's words differently — the transcript is the primary source.
Mark INCORRECT only when the value is garbage/malformed, semantically WRONG (different date/number/name), truncated beyond recognition, contradicts what the caller conveyed, or asserts unsupported facts, AND is not justified by the configuration. A value the config DIRECTS is correct by definition, even when it cannot be found in the transcript. This includes a default stated in the variable rule, a payload mandated by the node instructions for the active branch, a prescribed mapping/bucket, and a value the rule authorizes from call context. For extraction semantics, the variable's own recording rule is authoritative; use the node instructions to determine the active path and recording opportunity, but never add a precondition that the variable rule does not state. A rule such as "yes unless the caller disputes" makes yes the configured default and does not require an affirmative reply; silence or no dispute is enough unless the rule says otherwise. NEVER mark that configured yes value incorrect merely because the caller did not answer or affirm. Do not invent an identity, confirmation, or reached-question prerequisite. An exception applies only when the transcript establishes that exception: an unanswered identity question is not evidence of a wrong person, and a callback request is not a dispute. Never require confirmation the config does not require.
EXPLICIT-SPEECH GATE OVERRIDES CONFIG MAPPINGS: when the variable's own rule says to capture a value "when the caller states it", "only when explicitly stated", or equivalent, the caller's words must themselves establish the stored category. A list of configured buckets does not authorize choosing one by inference: "a lot" cannot become "more than six", and "soon" cannot become a specific timeline bucket. Mark that stored value INCORRECT. This explicit-speech gate is the exception to the config-directed-value rule above.

AUTHORITATIVE DECISION EXAMPLES — follow these outcomes even when a long node prompt contains competing general guidance:
- PASS — configured no-dispute default: a rule says to record yes when the caller remembers OR does not dispute, and the caller requests a callback without disputing it. Stored yes is correct; no affirmative reply is required.
- PASS — final-batch cutoff: the node says to submit lead data before ending or transfer; the transfer explanation is interrupted; the caller replies; and the transcript ends without another agent or tool turn. The configured final recording batch had no opportunity to run, so its pending values are not missing.
- PASS — early not-interested path: the caller declines before qualification. Later qualification variables in the expected list are inapplicable because their questions and gates were never reached.
- FAIL — completed-call omission: the caller explicitly states an applicable name, amount, or date; the call continues or completes; and the applicable value is never stored. List that exact variable in missing_variables.
- FAIL — invented precise bucket: the caller says only "a lot", while the variable rule allows a specific bucket only when the caller states it; the agent stores "more than six". List that variable in incorrect_variables because the precise category was inferred, not stated.

Score: 1.0 all correct | 0.75 minor issues | 0.5 notable gaps | 0.25 most missing/incorrect | 0.0 complete failure.

Pass if all extracted variables are valid and grounded. Fail for extra or fabricated variables, or a required value that was provided but missing/wrong. Maybe for minor issues.

When ambiguous, favor extraction_successful=true if the values are approximately correct. "Approximately correct" covers normalization, reformatting, and paraphrase of what the caller actually said; it does NOT cover bucketing, thresholding, or classifying a vague utterance into a precise category the caller never expressed. This leniency applies to VALUE disputes only — never to omissions: an EMPTY extraction set is not automatically a pass. When the caller EXPLICITLY STATED a value for an expected variable during this node (including an explicit enum condition being met) and nothing was stored, that is a real failure — list it in missing_variables and fail. The omission carve-outs in steps 3-6 still apply.`;

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

TERMINAL TRANSFER CUTOFF: on this platform a transfer/handoff ends the AI session the instant it fires — the transcript is exported at that same moment, so the handoff tool call, any configured connecting line, and everything after them cannot appear in the transcript. A System_Note: line stating the transfer executed is definitive evidence that it did. Even WITHOUT such a note: when the instructions make a transfer/handoff a terminal step — an offered transfer the caller consents to, a caller-requested human, or a configured immediate/silent handoff — and the transcript simply ENDS with no further agent or tool turn (whether the last turn is the caller's consent, the caller's request, any caller utterance, or even the agent's opening), the transfer either executed outside the visible transcript or the caller hung up first — and a step the agent never got a turn to perform is UNREACHABLE, not missed, in both cases. NEVER mark the terminal transfer/connect step as missed, fail procedure_compliance, or set objective_progress achieved=false (abandoned_goal) because that step is absent at the end of the transcript — score those aspects from the steps that ARE visible. A transfer counts as missed ONLY when the conversation visibly CONTINUES (further agent or caller turns) past the point where the transfer should have fired, with no transfer evidence.

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

const OUT_VARIABLE = `Return ONLY a JSON object. HARD EXCLUSIONS: NEVER put agent-composed summaries/statuses/labels, absent defaults or other rule-produced workflow fields, backend/platform/tool/lookup values, unopened-gate variables, a configured yes-when-not-disputed default, or values pending a final recording batch prevented by truncation in missing_variables or incorrect_variables. A caller reply after an interrupted transfer/ending turn with no following agent/tool turn is truncation. missing_variables = ONLY APPLICABLE caller-capture variables whose value the caller EXPLICITLY STATED but the agent did not store — never inferred, derived, defaulted, duplicated, backend, tool, or lookup values; workflow/default fields are excluded too. incorrect_variables = applicable caller-capture values that are wrong or contradict the caller under the INCORRECT test above — not config-directed defaults or agent-authored workflow metadata. Use the exact variable names; empty arrays if none:
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
