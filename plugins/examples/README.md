# Plugin Examples

Reference agent eval suites — one set per framework. These files (a) prove the
plugins ingest data correctly and (b) give developers a copy-paste blueprint for
testing their own LiveKit or Pipecat agents.

## Files

### Simple agents (starter examples)

| File | Framework | What it shows |
|------|-----------|----------------|
| `pytest/livekit_agent.py` | pytest + LiveKit (Python) | `Assistant` class, tool-call assertions, `.judge()` evals, agent handoff, off-task resistance |
| `pytest/pipecat_agent.py` | pytest + Pipecat (Python) | Real `OpenAILLMService` pipeline, tool-call assertions, `OpenAIJudge` evals, off-task resistance |
| `vitest/vitest_agent.ts` | Vitest (Node/TS) | Same shape, same test cases, same assertions |

### Complex multi-agent example

A retail-banking voice assistant with 5 cooperating agents (Greeter, Auth,
Accounts, Transactions, Loans). Tests cover 15+ scenarios: auth flow, exact
tool-call shape, structured argument assertions (e.g. `transfer_funds` with
`to_account`/`amount_cents`), guards against unauthenticated access, privacy
refusals, prompt injection, and every handoff in the agent graph.

| File | Framework |
|------|-----------|
| `pytest/livekit_banking_agent.py` | pytest + LiveKit (Python) |
| `pytest/pipecat_banking_agent.py` | pytest + Pipecat (Python) |
| `vitest/vitest_banking_agent.ts` | Vitest (Node/TS) |

Notable patterns:

- **Shared `UserData`** carries the authenticated `Profile` between agents.
  Specialist tools read `ctx.userdata.profile` (py) / `ctx.userData.profile`
  (ts) to gate access.
- **Deterministic tool stubs** — every "database" call returns a fixed value
  so the only nondeterminism is in the LLM's behavior under test.
- **Mix of exact assertions** (`contains_function_call(arguments={...})`) **and
  LLM-judged intents** (privacy, refusals).
- The Pipecat examples are text-only but driven by a real `OpenAILLMService`:
  the LLM itself decides when to call which tool, just like in production.
  All Pipecat examples therefore require `OPENAI_API_KEY`. State that needs
  to flow between tools (e.g. authenticated profile in
  `pipecat_banking_agent.py`) is held in a closure inside `build_pipeline()`
  so each test gets a fresh context.

### LLM-generated scenarios

You describe the agent (role + instructions + tool signatures). At
test-collection / module-load time, the runner calls OpenAI to generate N
diverse scenarios. Each generated scenario becomes its own parametrized
pytest case / `it.each` Vitest case. A second LLM judges each reply against
the generator's `judge_intent`; an optional `expected_tool` check is
enforced strictly.

| File | Framework | Purpose |
|------|-----------|---------|
| `pytest/livekit_scenario_runner.py` / `vitest/scenarioRunner.ts` | library | Reusable core: `generate_scenarios`, `run_scenario`, `run_scenarios`, `summarize` |
| `pytest/livekit_generated_agent.py` | pytest (Python) | Parametrized generated tests over `PizzaShopAgent` |
| `pytest/pipecat_scenario_runner.py` | library | Pipecat dynamic scenario generation (with hardcoded fallback scenarios for local pytest collection only — the agent itself always runs against a real LLM) |
| `pytest/pipecat_generated_agent.py` | pytest + Pipecat (Python) | Parametrized generated tests over a text-mode `OpenAILLMService`-driven pizza pipeline; judges each reply with `OpenAIJudge` |
| `vitest/vitest_generated_agent.ts` | Vitest (Node/TS) | `it.each` generated tests over `PizzaShopAgent` |

How it works:

1. Define an `AgentSpec` (name, role, instructions, tool signatures).
2. At collection / module-load time, `generate_scenarios(spec, n)` calls
   OpenAI with a JSON-schema response format so the output shape is
   guaranteed. This hits the API once per test run.
3. Each scenario is turned into a test case. The generator is asked to cover
   happy paths, edge cases, refusals, and any auth boundary implied by the
   instructions.
4. For each case: run the agent, capture tool calls + assistant reply, ask
   the judge model if the reply meets the intent, and fail the case if the
   verdict is `fail` (or if `expected_tool` wasn't called).

Python gotcha: pytest needs the parametrize iterable to be concrete *before*
any tests run, so generation happens synchronously at import time (via
`asyncio.run`). We cache the result in the module so a single pytest run
hits the API once.

Node equivalent: ES-module top-level `await` in `vitest/vitest_generated_agent.ts`
does the same thing declaratively.

Pipecat note: `pytest/pipecat_generated_agent.py` runs the agent under test
against a real `OpenAILLMService` and judges each reply with `OpenAIJudge`,
so it requires `OPENAI_API_KEY`. If the key is missing at module-load time,
scenario generation falls back to a small set of hardcoded scenarios just so
pytest collection still works — but the parametrized cases will themselves
fail when they try to call OpenAI.

### HTTP-triggered test runners

A FastAPI server (Python) and a Bun server (Node) that expose the same
evaluations over HTTP. Both invoke the test frameworks **in-process** via
their SDKs — no subprocess, no CLI — and reuse the LLM-generated scenario
agent directly.

| File | Framework |
|------|-----------|
| `pytest/livekit_fastapi_runner.py` | FastAPI + `pytest.main()` |
| `vitest/bun_runner.ts` | Bun HTTP server + `startVitest` from `vitest/node` |

Both servers expose two endpoints:

| Endpoint | What it does |
|----------|--------------|
| `POST /run/pytest` / `POST /run/vitest` | Invokes the test framework in-process on `pytest/livekit_generated_agent.py` / `vitest/vitest_generated_agent.ts`. A custom reporter/plugin captures per-case outcomes and durations; results come back as JSON. Third-party plugins (including `pytest-agent-observability` / `vitest-agent-observability` when installed) fire their hooks as usual and upload results to the dashboard. |
| `POST /run/scenarios` | Bypasses the test-framework framing entirely. Imports `livekit_generated_agent` / `vitest_generated_agent` and calls its exported `run_all()`. Same generated scenarios, same agent, same judgments — returned as raw JSON. |

Both endpoints accept `{"n": 5}` to control how many scenarios the LLM
generates.

Example:

```bash
# Python side — `uv run` auto-installs inline deps declared in the file
export OPENAI_API_KEY=sk-...
uv run plugins/examples/pytest/livekit_fastapi_runner.py

curl -X POST http://localhost:8080/run/pytest \
     -H content-type:application/json -d '{"n": 5}' | jq
curl -X POST http://localhost:8080/run/scenarios \
     -H content-type:application/json -d '{"n": 5}' | jq

# Node side
cd plugins/examples/vitest && bun install       # once
export OPENAI_API_KEY=sk-...
bun run runner

curl -X POST http://localhost:8080/run/vitest \
     -H content-type:application/json -d '{"n": 5}' | jq
curl -X POST http://localhost:8080/run/scenarios \
     -H content-type:application/json -d '{"n": 5}' | jq
```

> **Why in-process?** Spawning `pytest` / `vitest` as a subprocess works but
> adds startup overhead on every request and makes it harder to pass the
> caller's `n` parameter without env-var stuffing. Calling the SDKs directly
> keeps everything in one process and one asyncio loop.

## Environment variables

| Variable | Required | Used by | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | yes for every example | LiveKit and Pipecat examples | Backs the agent's LLM (via `livekit-plugins-openai` or `pipecat.services.openai.llm.OpenAILLMService`) and the LLM judge. The generated-scenario examples also use it to call `chat.completions` for scenario generation. |
| `AGENT_OBSERVABILITY_AGENT_MODEL` | no | Pipecat examples | OpenAI model that drives the agent under test. Default `gpt-4.1-mini`. |
| `AGENT_OBSERVABILITY_JUDGE_MODEL` | no | Pipecat examples | OpenAI model used by `pipecat-evals` `OpenAIJudge`. Default `gpt-4.1-mini`. |
| `AGENT_OBSERVABILITY_URL` | no | all pytest/vitest examples | Dashboard base URL (e.g. `http://localhost:9090`). Read by `pytest-agent-observability` / `vitest-agent-observability` when installed — if unset, tests still run but no eval data is uploaded. |
| `AGENT_OBSERVABILITY_AGENT_ID` | no | all pytest/vitest examples | Tag that groups eval runs under one agent in the dashboard. Pair with `AGENT_OBSERVABILITY_URL`. |
| `AGENT_OBSERVABILITY_GENERATED_N` | no | generated-scenario examples | How many scenarios the LLM should produce per run. Default `10`. The FastAPI/Bun endpoints also accept `{"n": N}` in the request body, which overrides this. |
| `PORT` | no | `livekit_fastapi_runner.py`, `bun_runner.ts` | HTTP port for the runner servers. Default `8080`. |
| `PYTEST_DISABLE_PLUGIN_AUTOLOAD` | no | FastAPI in-process runner | Set to `1` only if you want to suppress auto-discovery of installed pytest plugins (including `pytest-agent-observability`) during a `pytest.main()` call. Leave unset to keep default behavior. |

Not used by these examples, but note for completeness: if your
agent-observability server is gated with basic auth, it reads
`AGENT_OBSERVABILITY_USER` / `AGENT_OBSERVABILITY_PASS` — those belong in the
server's env, not the client's.

## Running locally

Export the env vars above (at minimum `OPENAI_API_KEY`) and run.

**Python** — runnable example scripts carry [PEP 723][pep723] inline script
metadata, so `uv run <file>` resolves and installs deps into an ephemeral
venv on first invocation. No `pip install` step.

[pep723]: https://peps.python.org/pep-0723/

```bash
export OPENAI_API_KEY=sk-...
export AGENT_OBSERVABILITY_URL=http://localhost:9090     # optional
export AGENT_OBSERVABILITY_AGENT_ID=demo-support-bot     # optional

# LiveKit — agent runs against `livekit-plugins-openai`.
uv run plugins/examples/pytest/livekit_banking_agent.py
uv run plugins/examples/pytest/livekit_generated_agent.py
uv run plugins/examples/pytest/livekit_fastapi_runner.py       # starts the HTTP server

# Pipecat — agent runs against `pipecat.services.openai.llm.OpenAILLMService`.
uv run plugins/examples/pytest/pipecat_agent.py
uv run plugins/examples/pytest/pipecat_banking_agent.py
uv run plugins/examples/pytest/pipecat_generated_agent.py
```

Pytest files work as runnable scripts because each has a `__main__` block
that calls `pytest.main([__file__, "-v"])` — the inline deps include pytest
and its async plugin, so `uv run` wires everything up in one command.

**Node:**
```bash
bun add @livekit/agents @livekit/agents-plugin-inference zod vitest openai
export OPENAI_API_KEY=sk-...
export AGENT_OBSERVABILITY_URL=http://localhost:9090     # optional
export AGENT_OBSERVABILITY_AGENT_ID=demo-support-bot     # optional
npx vitest run plugins/examples/vitest_banking_agent.ts
npx vitest run plugins/examples/vitest_generated_agent.ts
```

Tests call a real LLM — they aren't free, but they're cheap: text-only with
a small model (`gpt-4.1-mini` by default). A full run of any single file is
a handful of cents. The generated-scenario files add one extra call per run
for generation itself.

## Why these exist

LiveKit's eval framework and `pipecat-evals` both use
`AgentSession.run(user_input=...)` in **text-only** mode. The agent code under
test should be the bare agent or pipeline logic — not wrapped in a SIP,
telephony, or audio-stream entrypoint.

For agents built with `agent-transport`, the pattern is:

```python
# agent.py                                   # tests/test_agent.py
class Assistant(Agent):                      from agent import Assistant
    instructions = "..."
    @function_tool                           @pytest.mark.asyncio
    async def ...                            async def test_behavior():
                                                 async with AgentSession(...) as s:
# entrypoint.py                                      await s.start(Assistant())
@server.sip_session()                                result = await s.run(user_input="...")
async def main(ctx):                                 result.expect.next_event()...
    session = AgentSession(...)
    ctx.session = session
    await session.start(Assistant(),
                         room=ctx.room)
```

The `Assistant` class is identical in both paths — just imported into the
test instead of the entrypoint. No production behavior change; full eval
coverage unlocked.

## What "passes" vs. "fails"

Under the dashboard's summary rule (encoded in
`agent-observability/src/evals/summarize.ts`):

- A case is **passed** when pytest/Vitest assertions pass AND no `.judge()`
  call returned `verdict="fail"`. `"maybe"` verdicts don't demote a case.
- A case is **failed** if any assertion throws OR any judgment returns
  `verdict="fail"`.
- **errored** (uncaught exception) and **skipped** are orthogonal.

So you can write tests that pin exact structure (function name + args) AND
tests that just ask an LLM "did this response meet the intent?" — both count
toward pass rate, both show up in the case-detail panel.
