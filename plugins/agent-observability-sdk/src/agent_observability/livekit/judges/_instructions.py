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
