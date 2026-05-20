# agent-observability-sdk

Evaluation judges for AI voice agents — hallucination, response accuracy, intent
detection, tool correctness, and more. Ports the judge suite from
[cx-sqs-worker](https://github.com/plivo/cx-sqs-worker)'s Go-based
`vibe_eval/evaluator/metrics` into a Python library you can import directly or
plug into LiveKit's `JudgeGroup` via the bundled adapter.

## Install

```bash
pip install agent-observability-sdk

# To use the LiveKit adapter (requires livekit-agents ≥ 1.5.2 < 1.6):
pip install 'agent-observability-sdk[livekit]'
```

## Quick start

### Run a judge directly

```python
from agent_observability.judges import HallucinationJudge, EvaluationCase

judge = HallucinationJudge(model="gpt-5.2", threshold=0.7)
result = await judge.evaluate(EvaluationCase(
    chat_history=[
        {"role": "user", "content": "What's the refund policy for case 4823?"},
        {"role": "assistant", "content": "Case 4823 was refunded on 2024-03-15."},
    ],
    actual_response="Case 4823 was refunded on 2024-03-15.",
))

print(result.verdict, result.score, result.reasoning)
# → "fail" 0.2 "Fabricated refund date. User confused about status."
```

### Compose default + custom judges

```python
from agent_observability.judges import default_judges, IntentAccuracyJudge

judges = [
    IntentAccuracyJudge(expected_intent="book_flight"),
    *default_judges(),
]

# Run them all on a session
for j in judges:
    result = await j.evaluate(case)
    print(j.name, result.verdict)
```

### Use with LiveKit JudgeGroup

```python
from agent_observability.judges import HallucinationJudge, LiveKitAdapter
from livekit.agents.evals import JudgeGroup

group = JudgeGroup(
    llm=my_llm,
    judges=[LiveKitAdapter(HallucinationJudge())],
)
result = await group.evaluate(session.chat_history)
```

## Judges

### LLM-based (7)

- `hallucination_judge()` — does the response contain fabricated info?
- `rigid_response_accuracy_judge(expected_response=...)` — does the response match the expected text semantically?
- `freeflow_response_accuracy_judge()` — is the response appropriate given the conversation?
- `hold_requested_intent_accuracy_judge()` — was a "hold" request handled correctly?
- `variable_extraction_judge(expected_variables=..., actual_variables=...)` — were the right variables extracted?
- `loop_detection_judge()` — is the conversation stuck in a loop?
- `knowledge_base_correctness_judge(kb_context=...)` — does the response align with retrieved KB context?

### Programmatic (2, no LLM call)

- `IntentAccuracyJudge(expected_intent=..., actual_intent=...)` — case-insensitive string match.
- `ToolCorrectnessJudge(expected_tools=...)` — set-membership scoring; actual tools auto-extracted from `chat_ctx`.

`default_judges()` returns the 4 ground-truth-free ones (hallucination,
freeflow_response_accuracy, hold_requested_intent_accuracy, loop_detection).

Two cx-sqs-worker judges are intentionally NOT ported because their
prompts are tightly coupled to that runtime's flow-graph model:
`semi_rigid_response_accuracy` (depends on per-node instructions) and
`intent_detection` (depends on a closed available-intents list).

## License

MIT
