# Plugin Examples

Reference LiveKit agents with matching eval suites — one per framework. These
files (a) prove the plugins ingest data correctly and (b) give developers a
copy-paste blueprint for testing their own agent-transport voice agents.

## Files

| File | Framework | What it shows |
|------|-----------|----------------|
| `pytest_agent.py` | pytest (Python) | `Assistant` class, tool-call assertions, `.judge()` evals, agent handoff, off-task resistance |
| `vitest_agent.ts` | Vitest (Node/TS) | Same shape, same test cases, same assertions |

Both files define:

- **`GreeterAgent`** — a front-line agent that transfers to support.
- **`SupportAgent`** — a specialist with a `lookup_order(order_id)` tool.

The test cases exercise:

1. **Polite greeting** — LLM-judged.
2. **Exact tool call** — `lookup_order` with correct `order_id` argument.
3. **Missing-order grounding** — judge verifies no hallucination.
4. **Handoff** — greeter → support transition shows up as an `agent_handoff` event.
5. **Off-task refusal** — prompt injection attempt is rejected.

## Why these exist

LiveKit's eval framework (`AgentSession.run(user_input=...)`) is **text-only**.
The agent code under test must be the bare `Assistant` class — not wrapped in
a SIP or audio-stream entrypoint.

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

The `Assistant` class is identical in both paths — just imported into the test
instead of the entrypoint. No production behavior change; full eval coverage
unlocked.

## Running

These will work once the plugins ship (M2/M3). Until then, they still run as
plain LiveKit eval tests without the observability upload:

**Python:**
```bash
pip install "livekit-agents[openai]"  # or any text-capable plugin
export OPENAI_API_KEY=sk-...
# optional once plugin exists:
export AGENT_OBSERVABILITY_URL=http://localhost:9090
export AGENT_OBSERVABILITY_AGENT_ID=demo-support-bot
pytest plugins/examples/pytest_agent.py -v
```

**Node:**
```bash
npm install @livekit/agents @livekit/agents-plugin-inference zod vitest
export OPENAI_API_KEY=sk-...
# optional once plugin exists:
export AGENT_OBSERVABILITY_URL=http://localhost:9090
export AGENT_OBSERVABILITY_AGENT_ID=demo-support-bot
npx vitest run plugins/examples/vitest_agent.ts
```

Tests call a real LLM — they aren't free, but they're cheap: text-only with a
small model. A full run of either file is a handful of cents.

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
