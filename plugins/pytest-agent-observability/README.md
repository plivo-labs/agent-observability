# pytest-agent-observability

pytest plugin that uploads LiveKit-agents eval results to
[agent-observability](https://github.com/plivo-labs/agent-observability).

Each `pytest` run becomes one `eval_run` in the dashboard, with every test
function showing up as an `eval_case` including events, judgments, and failure
detail.

## Install

```bash
pip install pytest-agent-observability
```

Requires Python 3.9+ and `pytest>=7.0`. LiveKit integration is optional — the
plugin works for plain pytest suites too.

## Quick start

```bash
export AGENT_OBSERVABILITY_URL=http://localhost:9090
export AGENT_OBSERVABILITY_AGENT_ID=my-agent      # optional
pytest                                             # that's it
```

If `AGENT_OBSERVABILITY_URL` is unset, the plugin no-ops — your tests run
identically.

## With LiveKit eval tests

```python
import pytest
from livekit.agents import Agent, AgentSession, inference
from pytest_agent_observability import capture

class Assistant(Agent):
    def __init__(self):
        super().__init__(instructions="Be helpful.")

@pytest.mark.asyncio
async def test_greeting():
    async with inference.LLM(model="openai/gpt-4.1-mini") as llm, \
               AgentSession(llm=llm) as sess:
        await sess.start(Assistant())
        result = capture(await sess.run(user_input="Hello"))
        result.expect.next_event().is_message(role="assistant")
        await result.expect.next_event(type="message").judge(
            llm, intent="greets politely",
        )
```

`capture(result)` attaches the `RunResult` to the current test. `.judge(...)`
calls are intercepted automatically — you don't need to do anything extra to
record intents, verdicts, or reasoning.

## Configuration

| Env var | CLI flag | Purpose |
|---|---|---|
| `AGENT_OBSERVABILITY_URL` | `--agent-observability-url` | Base URL of the server (required for upload) |
| `AGENT_OBSERVABILITY_AGENT_ID` | `--agent-observability-agent-id` | Free-form agent identifier for the dashboard |
| `AGENT_OBSERVABILITY_ACCOUNT_ID` | `--agent-observability-account-id` | Multi-tenant account id |
| `AGENT_OBSERVABILITY_USER` | — | Basic-auth user (when server enables auth) |
| `AGENT_OBSERVABILITY_PASS` | — | Basic-auth password |

CI metadata (GitHub / GitLab / CircleCI / Buildkite) is auto-detected from
standard env vars. No configuration required.

## Behavior

- One `POST /observability/evals/v0` at `pytest_sessionfinish`.
- 10-second timeout, 3 retries with exponential backoff (1s, 2s, 4s).
- On total upload failure: payload is written to
  `.pytest_cache/agent-observability/<run_id>.json` for manual inspection.
- Never raises — upload issues won't fail your test suite.

## Development

```bash
cd plugins/pytest-agent-observability
pip install -e ".[dev]"
pytest
```
