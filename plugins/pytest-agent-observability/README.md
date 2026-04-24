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

**Auto-capture is on by default.** The plugin monkey-patches
`AgentSession.run` so every `RunResult` flows into the collector
automatically — in practice you rarely need to call `capture(result)` at
all. The helper remains exported for RunResults produced outside the
standard `.run()` path, and it's idempotent so calling it on an
already-captured result is a no-op.

`.judge(...)` calls on LiveKit's assertion API are intercepted
automatically. Verdict, intent, and reasoning are recorded as a first-class
Judgment event in the dashboard.

> **Node/TypeScript users:** the mirror plugin
> [`vitest-agent-observability`](../vitest-agent-observability/) exposes
> the same behavior. The manual helper is named `captureRunResult(result)`
> there (vs. `capture(result)` here); the auto-capture and `.judge()`
> interception are identical across both sides.

## Configuration

| Env var | CLI flag | Purpose |
|---|---|---|
| `AGENT_OBSERVABILITY_URL` | `--agent-observability-url` | Base URL of the server (required for upload) |
| `AGENT_OBSERVABILITY_AGENT_ID` | `--agent-observability-agent-id` | Free-form agent identifier for the dashboard |
| `AGENT_OBSERVABILITY_ACCOUNT_ID` | `--agent-observability-account-id` | Multi-tenant account id |
| `AGENT_OBSERVABILITY_USER` | — | Basic-auth user (when server enables auth) |
| `AGENT_OBSERVABILITY_PASS` | — | Basic-auth password |
| `AGENT_OBSERVABILITY_TIMEOUT` | `--agent-observability-timeout` | Upload request timeout in seconds (default `10`) |
| `AGENT_OBSERVABILITY_MAX_RETRIES` | `--agent-observability-max-retries` | Max upload attempts before falling back (default `3`) |
| `AGENT_OBSERVABILITY_FALLBACK_DIR` | `--agent-observability-fallback-dir` | Directory for failed-upload JSON (defaults to `.pytest_cache/agent-observability`) |

CI metadata (GitHub / GitLab / CircleCI / Buildkite) is auto-detected from
standard env vars. No configuration required.

## Behavior

- One `POST /observability/evals/v0` at `pytest_sessionfinish`.
- 10-second timeout, 3 retries with exponential backoff (1s, 2s, 4s).
- On total upload failure: payload is written to
  `.pytest_cache/agent-observability/<run_id>.json` for manual inspection.
- Never raises — upload issues won't fail your test suite.

## Running evals from a server

You can invoke pytest programmatically from a FastAPI (or any WSGI/ASGI)
server so your evals run on demand — useful for CI webhooks, scheduled
runs, or an internal "re-grade this agent" button. The plugin attaches
the same way it does on the CLI, so each HTTP-triggered run lands in
the dashboard as its own `eval_run`.

Use `pytest.main()` in-process:

```python
from fastapi import FastAPI
import pytest

app = FastAPI()

class JsonCollector:
    """Collect per-case outcomes into a list we can serialize."""
    def __init__(self):
        self.cases = []

    def pytest_runtest_logreport(self, report):
        if report.when == "call":
            self.cases.append({
                "name": report.nodeid,
                "outcome": report.outcome,
                "ms": int(report.duration * 1000),
            })

@app.post("/run")
async def run(files: list[str]):
    collector = JsonCollector()
    # pytest.main runs in the current process, picks up pyproject.toml /
    # conftest.py, and activates pytest-agent-observability like any
    # normal invocation. The extra plugin argument registers our
    # in-memory collector alongside it.
    code = pytest.main([*files, "-q"], plugins=[collector])
    return {"passed": code == 0, "cases": collector.cases}
```

Notes:

- `pytest.main()` re-uses the current process, so the plugin reads
  `AGENT_OBSERVABILITY_URL` from the server's environment and uploads
  the run. Set those vars on the server process, not per request.
- A single process can only run one `pytest.main()` at a time —
  pytest's `conftest` machinery and plugin registries are global. For a
  throughput-oriented server, spawn a subprocess per request
  (`subprocess.run(["pytest", …])`) or queue requests.
- `pytest.main()` triggers the asyncio plugin's event-loop setup; if
  your FastAPI endpoint is already on a loop, run it through
  `asyncio.to_thread(...)` to keep the loops separate.

A working reference server with both `/run/pytest` (full pytest run)
and `/run/scenarios` (bypasses pytest, calls the scenario runner
directly) lives at
[`plugins/examples/pytest/fastapi_runner.py`](../examples/pytest/fastapi_runner.py).
Its Node mirror using `startVitest` from Bun is at
[`plugins/examples/vitest/bun_runner.ts`](../examples/vitest/bun_runner.ts).

## Development

```bash
cd plugins/pytest-agent-observability
pip install -e ".[dev]"
pytest
```
