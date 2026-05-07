# pipecat-evals

`pipecat-evals` provides a small LiveKit-style eval API for text-mode Pipecat
agents. It is intentionally separate from `pytest-agent-observability`: this
package runs and asserts evals, while `pytest-agent-observability` uploads the
captured results to the dashboard.

V1 is text-only. It does not exercise audio, STT, TTS, VAD, SIP, or telephony.

## Install

```bash
pip install pipecat-evals
```

For local development in this repo:

```bash
cd plugins/pipecat-evals
pip install -e ".[dev]"
```

Install Pipecat separately in the application that owns the agent pipeline.
Install the OpenAI extra if you want the built-in LLM judge:

```bash
pip install "pipecat-evals[openai]"
```

## Usage

```python
import pytest
from pipecat_evals import AgentSession

def build_pipeline():
    # Return a normal Pipecat Pipeline.
    ...

@pytest.mark.asyncio
async def test_greeting():
    async with AgentSession() as session:
        await session.start(build_pipeline)
        result = await session.run(user_input="Hello")

    result.expect.next_event().is_message(role="assistant")
    result.expect.contains_message(content_contains="hello")
```

The API mirrors the parts of LiveKit's pytest testing API that are useful for
text evals:

- `AgentSession.start(...)` accepts a Pipecat pipeline or a pipeline factory.
- `await session.run(user_input="...")` queues text into the Pipecat context.
- The returned `RunResult` exposes `events` and `expect`.
- `ChatMessageAssert.judge(...)` records pass/fail compatible with
  `pytest-agent-observability`.

For LLM-judged assertions, pass `OpenAIJudge` to the same `.judge(...)` API:

```python
from pipecat_evals import OpenAIJudge

await result.expect.contains_message(role="assistant").judge(
    OpenAIJudge(model="gpt-4.1-mini"),
    intent="politely answers the user's refund question",
)
```

Set `OPENAI_API_KEY` in the test environment. You can also pass a custom
OpenAI-compatible async client with a `chat.completions.create(...)` method.
Like LiveKit, `.judge(...)` returns the message assertion for chaining; the
normalized `JudgeResult` is available as `assertion.judgment`.

When `pytest-agent-observability` is installed and configured, `RunResult`
objects returned by this package are auto-captured and uploaded with
`framework="pipecat"` and `testing_framework="pytest"`. The upload integration
uses `pipecat-evals` observer hooks rather than monkeypatching the eval API.

## Mock Tools

`mock_tools(...)` temporarily registers deterministic function handlers on a
Pipecat LLM service that exposes `register_function`.

```python
from pipecat_evals import mock_tools

with mock_tools(llm, {"lookup_order": lambda args: {"status": "shipped"}}):
    result = await session.run(user_input="Where is order 123?")
```

## Examples

Runnable examples live in [`examples/`](examples/). From this package directory:

```bash
PYTHONPATH=src pytest examples -q
```

The package-local examples are deterministic and do not require real LLM
credentials. The plugin examples under `../examples/pytest` include
`pipecat_generated_agent.py`, which switches to `OpenAIJudge` when
`OPENAI_API_KEY` is set.
