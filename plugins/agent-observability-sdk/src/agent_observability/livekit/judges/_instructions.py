"""Judge instruction strings.

Each constant captures the Criteria + Steps from cx-sqs-worker's
`MetricPromptConfig`
(`cx-sqs-worker/usecases/vibe_eval/evaluator/prompt/configs.go`), rewritten to
the imperative voice LiveKit's `Judge` expects in `instructions`.

LiveKit's `Judge.evaluate` already wraps the instructions inside a
"Criteria: …" preamble and prepends the conversation, so the strings here
are the criteria body only — no surrounding scaffolding.

Where a judge needs ground truth that lives outside the conversation
(expected response, available intents, KB context, …), the factory
function uses `.format()` to splice it into the template. Anything inside
the template that would be ambiguous when string-formatted (e.g. literal
braces) is escaped.
"""

HALLUCINATION = """\
Does the agent's response contain fabricated information not supported by any \
valid evidence source? Hallucination is ONLY about factual accuracy — NOT \
formatting, style, or instruction compliance.

Steps:
1. Identify every specific factual claim in the agent's messages (names, \
numbers, dates, statuses, policies).
2. For each claim, check valid evidence sources: the conversation history, \
function call outputs, and the agent's instructions.
3. A claim is hallucinated ONLY if it appears in NONE of those sources AND \
contradicts context.
4. NOT hallucination: opinions, apologies, offers to help, saying \"I don't \
know\", or referencing policies/variables from context.

Pass if all claims are supported. Fail if any critical fact is fabricated. \
Maybe if there are minor unsupported details that don't change the meaning."""


RIGID_RESPONSE_ACCURACY = """\
Does the agent's latest response have the same semantic meaning as the \
expected response? Focus on whether the core meaning matches, not exact \
wording.

Expected response:
{expected_response}

Steps:
1. Identify the core meaning/intent of the expected response.
2. Check whether the agent's response conveys the same core meaning.
3. Allow rephrasing, synonyms, different sentence structure, minor politeness.
4. Penalize missing key information, contradictory statements, or completely \
different topic.

Pass if meanings match. Fail if completely different. Maybe for partial match."""


FREEFLOW_RESPONSE_ACCURACY = """\
Does the agent's response naturally continue the conversation and \
acknowledge previous context? Focus on contextual connection, not \
completeness of the answer.

Steps:
1. Check whether the response acknowledges or builds upon previous exchanges.
2. Check whether the response is topically connected to the conversation.

Pass if the response is contextually connected (even if incomplete). Fail \
if the response ignores history, repeats answered questions, or seems to \
start fresh. Maybe for minor disconnection."""


HOLD_REQUESTED_INTENT_ACCURACY = """\
Was a hold/wait response from the agent appropriate? An agent should only \
indicate it is putting the user on hold (or asking them to wait) when the \
user explicitly asked to wait, pause, or needs a moment.

Steps:
1. Identify the agent's most recent response. Does it tell the user to hold, \
wait, pause, or take a moment?
2. If the agent did NOT ask the user to hold, this metric does not apply — \
pass.
3. If the agent DID ask the user to hold, find the user's last message.
4. Did the user use explicit hold language ("wait", "hold on", "one moment", \
"give me a second", etc.)?

Pass if the user clearly asked to wait, or if the agent never asked to hold. \
Fail if the agent put the user on hold without a clear request."""


VARIABLE_EXTRACTION = """\
Were the agent's extracted variables correct? Each extracted variable must \
(1) be in the variables-to-extract list and (2) have a value grounded in the \
context.

Variables expected to be extracted (allowed names):
{expected_variables}

Variables the agent actually extracted:
{actual_variables}

Steps:
1. For each entry in actual variables: does the name appear in the expected \
list? If not, fail (extra variables).
2. For each extracted value: can the value be found in the conversation or \
provided data? Fabricated values should be penalized.
3. Was any expected variable's value available in the context but NOT \
extracted? That's a critical miss.
4. Omitting a variable is OK if its value is truly not available in context.

Pass if all extracted variables are valid and grounded. Fail for extra or \
fabricated variables. Maybe for minor issues."""


LOOP_DETECTION = """\
Does the agent inappropriately repeat its own previous messages without \
justification? Loops indicate the agent is stuck.

Steps:
1. Look at the agent's most recent message.
2. Compare it to the last 2–3 prior agent messages in the conversation.
3. Is the latest message substantially identical to a recent one?
4. If similar, does new user input or new context justify repeating?

Pass if the message is new or repetition is justified. Fail for unjustified \
repetition of the same substantive question or information. Greetings, \
sign-offs, and short acknowledgements ("Got it", "Sure", "How can I help?") \
are allowed to repeat."""


KNOWLEDGE_BASE_CORRECTNESS = """\
The agent DID call a knowledge base / retrieval tool during this \
conversation. Was the call necessary? A KB call is correct if the answer was \
NOT already available in the context.

Knowledge base context returned by the tool:
{kb_context}

Steps:
1. Identify the user's last question that prompted the KB call.
2. Search the conversation and any function call outputs for explicit data \
that answers this question.
3. If the answer was already in context, the KB call was unnecessary — \
maybe.
4. If the answer was NOT in context, the KB call was appropriate — pass.

A KB call can still be appropriate even with partial context if more detail \
was needed."""


VOICEMAIL_DETECTION = """\
Detect whether the conversation reached voicemail. This is a voice-channel \
classifier. Pass when the transcript is NOT voicemail. Fail when direct \
voicemail is detected.

Criteria:
1. Direct voicemail greetings, mailbox prompts, or leave-a-message flows mean \
voicemail_detected=true.
2. Call screening is NOT voicemail; classify screening separately even if it \
eventually asks for a message.
3. Bot/IVR menus are NOT voicemail.
4. Human conversation after an automated prompt means voicemail_detected=false."""


BOT_DETECTION = """\
Detect whether the call was answered by an automated IVR/bot system rather \
than a human. Pass when no bot/IVR is present. Fail when bot_detected=true.

Criteria:
1. Menu prompts such as press 1, say billing, main menu, or repeat options are \
bot/IVR indicators.
2. Self-identification as an automated assistant, virtual assistant, AI \
assistant, or phone system is a bot indicator.
3. Voicemail and call screening are separate outcomes and should not be marked \
as bot_detected.
4. Analyze the answered party's messages, not the agent's own wording."""


CALL_SCREENING = """\
Detect automated call screening where a system asks who is calling and why, \
and the real person does not subsequently answer. Pass when no unresolved call \
screening is present. Fail when call_screening=true.

Criteria:
1. iOS/Android/Google call screening asks for the caller's name, purpose, or \
reason for calling.
2. If the real person starts conversing after the screening prompt, screening \
was resolved and should not fail.
3. Screening followed by voicemail remains call_screening, not voicemail.
4. IVR menus with numbered routing options are bot/IVR, not call screening."""


LOW_ENGAGEMENT = """\
Detect low engagement: a real human answered but only gave minimal greetings \
or acknowledgements and never engaged with the topic. Pass when the user \
engaged meaningfully or the metric does not apply. Fail when low_engagement=true.

Criteria:
1. Applies after a human answered, not voicemail, call screening, or bot/IVR.
2. User messages are only brief greetings or acknowledgements such as hello, \
yes, yeah, speaking, okay.
3. Any substantive question, provided information, disinterest, wrong-number \
statement, or opt-out is not low engagement."""


WRONG_NUMBER = """\
Detect whether the user indicates they are not the intended recipient. Pass \
when wrong_number=false. Fail when wrong_number=true.

Criteria:
1. User says wrong number, wrong person, I do not know them, nobody by that \
name, or otherwise rejects the identity target.
2. General confusion about the purpose of the call is not enough.
3. Applies to voice, chat, SMS, and WhatsApp style transcripts."""


DO_NOT_DISTURB = """\
Detect whether the user explicitly asks not to be contacted again. Pass when \
do_not_disturb=false. Fail when do_not_disturb=true.

Criteria:
1. Explicit opt-out language such as do not call me again, remove me, stop \
contacting me, take me off your list, or similar means true.
2. Simple disinterest is not enough unless it includes a future-contact ban.
3. Applies to voice, chat, SMS, and WhatsApp style transcripts."""


USER_SENTIMENT = """\
Classify the user's sentiment as positive, neutral, negative, confused, or \
not_applicable. Pass unless the sentiment is clearly negative or confused in a \
way that indicates poor user experience; maybe for weak signals.

Rules:
1. positive: cooperative, receptive, appreciative.
2. neutral: minimal but valid engagement.
3. negative: dissatisfaction, rejection, hostility, frustration, opt-out.
4. confused: repeated uncertainty or requests for clarification.
5. not_applicable: no human interaction, voicemail, screening, or bot/IVR."""


CONVERSATION_STATUS = """\
Derive the overall conversation status from the transcript. Use one of: \
unanswered, human_contact, silent_conversation, voicemail_detected, \
call_screening, bot_detected, low_engagement, wrong_number, do_not_disturb, \
transferred_to_human.

Priority for voice filtering outcomes:
1. voicemail_detected
2. call_screening
3. bot_detected
4. low_engagement
5. wrong_number
6. do_not_disturb
7. transferred_to_human
8. human_contact

Pass when the final status is human_contact or transferred_to_human. Fail for \
filtering outcomes. Maybe when evidence is ambiguous."""


INSTRUCTION_ADHERENCE = """\
Evaluate whether the agent followed its instructions for this scenario. Use \
the cx-style four-part rubric: objective_progress, procedure_compliance, \
interaction_quality, and policy_boundary_compliance.

Agent instructions:
{instructions}

Optional scenario objective:
{objective}

Rubric:
1. Objective progress: did the agent move toward the intended task outcome?
2. Procedure compliance: did it follow mandatory steps, confirmations, and \
ordering constraints?
3. Interaction quality: was it clear, professional, not overloaded, and \
responsive to the user?
4. Policy boundary compliance: did it avoid unsafe, forbidden, or out-of-scope \
behavior?

Pass only when objective, procedure, and policy are satisfied. Maybe for minor \
interaction quality issues that do not change the outcome. Fail for critical \
missed steps, objective failure, or policy violation."""


INTENT_IDENTIFICATION = """\
Evaluate whether the agent/framework selected the correct intent for the \
conversation segment.

Available intents:
{available_intents}

Chosen intent:
{chosen_intent}

Rules:
1. intent_not_found=true when the user's intent is valid but not represented \
in the available intent list.
2. intent_wrongly_identified=true when the chosen intent does not match the \
user's actual request.
3. System intents such as hangup, error, failed, sent, or conversation_complete \
are acceptable when they match a system interruption.

Pass when the chosen intent is supported and correct. Fail when not found or \
wrongly identified. Maybe when the user input is ambiguous."""


GOAL_EVALUATION = """\
Evaluate whether the configured goals were achieved by the conversation.

Goals:
{goals}

Flow/run history or additional context:
{flow_history}

For each goal, decide whether the conversation achieved it. Pass when all \
required goals were achieved. Fail when any required goal was clearly missed. \
Maybe when the transcript lacks enough evidence."""


STT_EVALUATION = """\
Evaluate speech-to-text quality from the transcript. Detect transcription \
errors that caused misunderstanding or poor agent behavior.

Transcript:
{transcript}

Rules:
1. Identify likely STT mistakes in user messages.
2. Mark whether the agent recovered from each mistake.
3. Ignore harmless spelling, casing, punctuation, or accent artifacts that did \
not affect the conversation.
4. Fail when unrecovered STT errors materially changed the outcome. Maybe for \
minor or recovered errors. Pass when no material STT issue is visible."""


TURN_DETECTION = """\
Evaluate turn detection / end-of-utterance decisions from transcript \
fragments. Detect premature EOU and missed EOU.

Fragments / TD events:
{fragments}

Rules:
1. Premature EOU: the system ended the user's turn before the utterance was \
complete.
2. Missed EOU: the system delayed after a complete utterance.
3. Judge each fragment based on whether it is a complete utterance in context.
4. Fail when TD errors would cause interruption, latency, or wrong response. \
Maybe for borderline fragments. Pass when decisions look appropriate."""
