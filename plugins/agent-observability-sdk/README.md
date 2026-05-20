# agent-observability-sdk

Evaluation judges for AI voice agents — hallucination, response accuracy,
intent / tool correctness, loop detection, knowledge-base correctness, and
more. The judge prompts are ported from
[cx-sqs-worker](https://github.com/plivo/cx-sqs-worker)'s
`vibe_eval/evaluator/metrics` (Go) into Python factories that return
LiveKit's `_LLMJudge`, so every judge in this package plugs straight into
`livekit.agents.evals.JudgeGroup` next to LiveKit's built-ins
(`accuracy_judge`, `safety_judge`, …).

## Install

```bash
pip install agent-observability-sdk
```

`livekit-agents>=1.5.2,<1.6` is a hard dependency — installed automatically.

## Quick start

### Run a judge directly

```python
import asyncio
from livekit.agents.llm import openai, ChatContext
from agent_observability.judges import hallucination_judge

# 1. Construct an LLM the judge can call
llm = openai.LLM(model="gpt-4o-mini")

# 2. Build the conversation context you want to evaluate
ctx = ChatContext.empty()
ctx.add_message(role="user", content="What's the refund policy for order #4823?")
ctx.add_message(role="assistant", content="Order #4823 was refunded on 2024-03-15.")

# 3. Construct the judge and run it
judge = hallucination_judge(llm=llm)
result = asyncio.run(judge.evaluate(chat_ctx=ctx))

print(result.verdict, "—", result.reasoning)
# → "fail — The agent fabricated a refund date not supported by context."
```

### Use with LiveKit `JudgeGroup`

```python
from livekit.agents.evals import JudgeGroup
from agent_observability.judges import hallucination_judge, loop_detection_judge

group = JudgeGroup(
    judges=[
        hallucination_judge(llm=llm),
        loop_detection_judge(llm=llm),
    ],
)
results = await group.evaluate(chat_ctx=session.chat_ctx)
for j in results:
    print(j.name, j.verdict, j.reasoning)
```

### Compose `default_judges()` with your own ground-truth-bound ones

`default_judges(llm=...)` returns the four LLM judges that work on a session
in isolation (no expected-response, no expected-intent, no KB context).
Spread them next to your own judges that need ground truth:

```python
from agent_observability.judges import (
    default_judges,
    IntentAccuracyJudge,
    ToolCorrectnessJudge,
    rigid_response_accuracy_judge,
)

judges = [
    # Programmatic — pure Python comparison, no LLM call
    IntentAccuracyJudge(
        expected_intent="book_flight",
        actual_intent=session.state.detected_intent,
    ),
    ToolCorrectnessJudge(expected_tools=["lookup_flights"]),

    # LLM with ground-truth response
    rigid_response_accuracy_judge(
        expected_response="Sure, what date works?",
        llm=llm,
    ),

    # The four ground-truth-free judges (Hallucination, FreeflowResponseAccuracy,
    # HoldRequestedIntentAccuracy, LoopDetection)
    *default_judges(llm=llm),
]
```

## Judges

### LLM-based (7 factories)

Each returns a LiveKit `_LLMJudge` you can pass straight to a `JudgeGroup`:

- `hallucination_judge(llm=...)` — does the response contain fabricated info?
- `rigid_response_accuracy_judge(*, expected_response, llm=...)` — does the response match the expected text semantically?
- `freeflow_response_accuracy_judge(llm=...)` — is the response contextually appropriate?
- `hold_requested_intent_accuracy_judge(llm=...)` — was a "hold" / "wait" response justified by the user?
- `variable_extraction_judge(*, expected_variables, actual_variables, llm=...)` — were the right variables extracted with grounded values?
- `loop_detection_judge(llm=...)` — is the agent stuck repeating itself?
- `knowledge_base_correctness_judge(*, kb_context, llm=...)` — was the KB lookup necessary?

### Programmatic (2 classes — no LLM call)

- `IntentAccuracyJudge(*, expected_intent, actual_intent)` — case-insensitive
  string match of expected vs. actual intent.
- `ToolCorrectnessJudge(*, expected_tools, threshold=1.0)` — set-membership
  scoring; the judge auto-extracts the actual tools called from
  `chat_ctx.items` (LiveKit's `function_call` events).

Both classes satisfy the LiveKit Judge protocol (a `name` property + async
`evaluate(*, chat_ctx, reference=None, llm=None) -> JudgmentResult`), so
they slot into `JudgeGroup` uniformly with the LLM factories.

### Composition helper

- `default_judges(llm=None) -> list[_LLMJudge]` — pre-configured set of the
  four ground-truth-free judges (Hallucination, Freeflow Response
  Accuracy, Hold-Requested Intent Accuracy, Loop Detection). Spread it
  alongside ground-truth-bound judges you construct by hand.

## Which judges need what data?

| Judge | Required at construction | Read from `chat_ctx` |
|---|---|---|
| `hallucination_judge` | — | full conversation |
| `rigid_response_accuracy_judge` | `expected_response` | full conversation (the agent's latest message is compared to expected) |
| `freeflow_response_accuracy_judge` | — | full conversation |
| `hold_requested_intent_accuracy_judge` | — | latest agent message + user's prior turn |
| `variable_extraction_judge` | `expected_variables`, `actual_variables` | full conversation (for grounding) |
| `loop_detection_judge` | — | latest agent message + prior 2–3 agent messages |
| `knowledge_base_correctness_judge` | `kb_context` | full conversation |
| `IntentAccuracyJudge` | `expected_intent`, `actual_intent` | — (ignored) |
| `ToolCorrectnessJudge` | `expected_tools` | `function_call` items (auto-extracted) |

For judges that need ground truth, pass values that come from your test
case / flow definition. For the dynamic ones (`actual_intent`,
`actual_variables`, `kb_context`), construct the judge after the session
when those values are known — judges are cheap to instantiate.

## Not ported from cx-sqs-worker

Two cx-sqs-worker judges are intentionally not ported because their
prompts are tightly coupled to the cx-sqs-worker flow-graph runtime
(global vs. node instructions, closed available-intents list):

- `semi_rigid_response_accuracy`
- `intent_detection`

Use `rigid_response_accuracy_judge` or `freeflow_response_accuracy_judge`
for response evaluation; use `IntentAccuracyJudge` for closed-set intent
checks.

## License

MIT
