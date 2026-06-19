# agent-observability-sdk

The Python SDK for shipping evals + telemetry to
[agent-observability](https://github.com/plivo-labs/agent-observability).
Three surfaces in one install:

- **LiveKit helpers** — bootstrap the tag bundle the v2 server expects
  (`init_observability`), declare conversation goals the server judges
  post-session (`goals=[Goal(...)]`, or `add_goal_tags` without the full
  bootstrap), run judges against a session report (`run_judges_on_report`),
  resolve the upload URL (`ensure_observability_url`). For workers that
  drive LiveKit Agents directly; agent-transport's `AudioStreamServer`
  does this internally.
- **Judges** — nine LiveKit-compatible judges ported from
  [cx-sqs-worker](https://github.com/plivo/cx-sqs-worker) (Hallucination,
  Response Accuracy, Tool Correctness, Loop Detection, …) plus a
  `default_judges()` composition helper. Plug straight into
  `livekit.agents.evals.JudgeGroup` alongside LiveKit's built-ins.
- **pytest plugin** — auto-registered via `pytest11` entry-point.
  Every `pytest` run becomes one `eval_run` in the dashboard; every
  test function becomes an `eval_case` with events, judgments, and
  failure detail. Same plumbing the deprecated standalone
  `pytest-agent-observability` package used to ship.

## Install

```bash
pip install agent-observability-sdk
```

`livekit-agents>=1.5.2,<1.6`, `pytest>=7.0`, and `httpx>=0.24` are hard
deps and installed automatically. Python ≥ 3.10.

## Quick start

### 1. Raw LiveKit worker (text or audio, your own `AgentServer`)

```python
from agent_observability.livekit import Goal, init_observability, run_judges_on_report
from livekit.agents import AgentServer, JobContext
from livekit.agents.evals import accuracy_judge, safety_judge

server = AgentServer()

async def on_session_end(ctx: JobContext) -> None:
    report = ctx.make_session_report()
    await run_judges_on_report(
        report,
        judges=[accuracy_judge(), safety_judge()],
    )

@server.rtc_session(agent_name="support-bot", on_session_end=on_session_end)
async def entrypoint(ctx: JobContext) -> None:
    init_observability(
        ctx.tagger,
        agent_id="9c2f7e3d-…",       # stable opaque UUID
        agent_name="support-bot",
        account_id="acct-7",
        transport="text",
        goals=[
            Goal("identity-check", "Confirm the caller's identity before account changes"),
            Goal("order-resolution", "Resolve the order issue or open a support ticket"),
        ],
    )
    # …your usual AgentSession.start(...) setup
```

That's the whole observability surface for a raw-LiveKit worker. No
hand-rolled `tagger.add(...)` calls, no `JudgeGroup` boilerplate, no
`llm.aclose()` cleanup.

**Conversation goals** — each `Goal(name, description)` (both required;
the name is colon-free and filterable, the description is what the judge
reads) is graded by the server after the session, and verdicts land on
the agent's Conversation Goals tab. The server does the judging, so this
needs `OPENAI_API_KEY` set there. Workers whose bootstrap happens
elsewhere (agent-transport) can emit goals on their own with
`add_goal_tags(ctx.tagger, [...])`.

### 2. agent-transport worker (`AudioStreamServer`)

Don't use the helpers — agent-transport already emits tags and runs
judges via its own `EvaluationConfig`. You only consume the **judges**
catalogue from this package:

```python
from agent_observability.livekit.judges import (
    default_judges,
    IntentAccuracyJudge,
    rigid_response_accuracy_judge,
)
from agent_transport import AudioStreamServer
from agent_transport.evaluation import EvaluationConfig
from livekit.agents.evals import accuracy_judge

ctx.evaluation = EvaluationConfig(
    judge_llm=judge_llm,
    judges=[
        accuracy_judge(),
        IntentAccuracyJudge(expected_intent="book_flight", actual_intent=...),
        rigid_response_accuracy_judge(expected_response="...", llm=judge_llm),
        *default_judges(llm=judge_llm),
    ],
)
```

### 3. pytest suite

The plugin is auto-discovered — install the SDK, point at the dashboard,
done. Tests with `AgentSession.run(...)` and `.judge(...)` work as-is.

```bash
export AGENT_OBSERVABILITY_URL=https://obs.example.com
export AGENT_OBSERVABILITY_AGENT_ID=9c2f7e3d-4b8a-4d2e-9f1b-…
pytest
```

```python
# In a test file
import pytest
from livekit.agents import AgentSession, inference

@pytest.mark.asyncio
async def test_greeting():
    async with inference.LLM(model="openai/gpt-4.1-mini") as llm, \
               AgentSession(llm=llm) as sess:
        await sess.start(Assistant())
        result = await sess.run(user_input="Hello")
        result.expect.next_event().is_message(role="assistant")
        await result.expect.next_event(type="message").judge(
            llm, intent="greets politely",
        )
```

**Auto-capture is on by default.** Every `RunResult` from
`AgentSession.run(...)` is collected automatically and `.judge(...)`
calls are intercepted as first-class Judgment events in the dashboard.
The `capture(result)` helper is exported for RunResults produced
outside the standard `.run()` path:

```python
from agent_observability.livekit.pytest import capture
```

## Configuration

| Env var | CLI flag | Purpose |
|---|---|---|
| `LIVEKIT_OBSERVABILITY_URL` | — | Dashboard base URL (LiveKit-canonical name). Required by `init_observability` (raises if unset). |
| `AGENT_OBSERVABILITY_URL` | `--agent-observability-url` | Same purpose; `init_observability` accepts this as a fallback and mirrors it into `LIVEKIT_OBSERVABILITY_URL` so LiveKit's upload code picks it up. |
| `AGENT_OBSERVABILITY_AGENT_ID` | `--agent-observability-agent-id` | Stable opaque agent identifier. Strongly recommended — without it the session lands unparented on the dashboard (the server accepts the upload but has nothing to backfill the FK with). UUIDs preferred over slugs. |
| `AGENT_OBSERVABILITY_ACCOUNT_ID` | `--agent-observability-account-id` | Multi-tenant account id. Optional. |
| `AGENT_OBSERVABILITY_USER` / `_PASS` | — | Basic-auth credentials when the server enables auth. Optional. |
| `AGENT_OBSERVABILITY_TIMEOUT` | `--agent-observability-timeout` | Upload request timeout in seconds (default `10`). |
| `AGENT_OBSERVABILITY_MAX_RETRIES` | `--agent-observability-max-retries` | Max upload attempts before falling back (default `3`). |
| `AGENT_OBSERVABILITY_FALLBACK_DIR` | `--agent-observability-fallback-dir` | Directory for failed-upload JSON (defaults to `.pytest_cache/agent-observability`). |

CI metadata (GitHub / GitLab / CircleCI / Buildkite) is auto-detected
by the pytest plugin from standard env vars — no configuration needed.

## Judge reference

### LLM-based (7 factories)

Each returns a LiveKit `_LLMJudge` you pass straight to a `JudgeGroup`:

- `hallucination_judge(llm=...)` — fabricated info?
- `rigid_response_accuracy_judge(*, expected_response, llm=...)` — semantic match against an expected text.
- `freeflow_response_accuracy_judge(llm=...)` — contextually appropriate in an open-ended conversation?
- `hold_requested_intent_accuracy_judge(llm=...)` — was a "hold" / "wait" reply justified?
- `variable_extraction_judge(*, expected_variables, actual_variables, llm=...)` — were the right values extracted, grounded in the transcript?
- `loop_detection_judge(llm=...)` — agent repeating itself?
- `knowledge_base_correctness_judge(*, kb_context, llm=...)` — KB lookup faithfully reflected?

### Programmatic (2 classes, no LLM call)

- `IntentAccuracyJudge(*, expected_intent, actual_intent)` — case-insensitive string match.
- `ToolCorrectnessJudge(*, expected_tools, threshold=1.0)` — auto-extracts function-call events from `chat_ctx`; set-membership scoring.

### Composition helper

- `default_judges(llm=None) -> list[Judge]` — the four ground-truth-free
  judges (Hallucination, Freeflow Response Accuracy, Hold-Requested
  Intent Accuracy, Loop Detection). Spread next to your own
  ground-truth-bound judges.

### Which judges need what data?

| Judge | Required at construction | Read from `chat_ctx` |
|---|---|---|
| `hallucination_judge` | — | full conversation |
| `rigid_response_accuracy_judge` | `expected_response` | latest assistant message |
| `freeflow_response_accuracy_judge` | — | full conversation |
| `hold_requested_intent_accuracy_judge` | — | latest assistant message + prior user turn |
| `variable_extraction_judge` | `expected_variables`, `actual_variables` | full conversation (for grounding) |
| `loop_detection_judge` | — | latest assistant message + prior 2-3 |
| `knowledge_base_correctness_judge` | `kb_context` | full conversation |
| `IntentAccuracyJudge` | `expected_intent`, `actual_intent` | — (ignored) |
| `ToolCorrectnessJudge` | `expected_tools` | `function_call` items (auto-extracted) |

## Migrating from `pytest-agent-observability`

The standalone `pytest-agent-observability` package is **discontinued**.
The last published release (0.2.1) still installs and runs, but
predates this SDK's helpers and judges. Migrate by switching the
dependency + import:

```diff
-pytest-agent-observability
+agent-observability-sdk
```

```diff
-from pytest_agent_observability import capture
+from agent_observability.livekit.pytest import capture
```

The plugin is auto-discovered via `pytest11` entry-point — no extra
config needed. Auto-capture, `.judge()` interception, retry / fallback
behaviour, and CI metadata extraction are byte-for-byte identical.

## Not ported from cx-sqs-worker

Two judges are intentionally absent because their prompts are tightly
coupled to the cx-sqs-worker flow-graph runtime (global vs. node
instructions, closed available-intents list):

- `semi_rigid_response_accuracy`
- `intent_detection`

Use `rigid_response_accuracy_judge` or `freeflow_response_accuracy_judge`
for response evaluation; use `IntentAccuracyJudge` for closed-set
intent checks.

## License

MIT
