# Vitest examples

Runnable reference eval suites that exercise the
[`vitest-agent-observability`](../../vitest-agent-observability/) reporter.

## Run

```bash
bun install
bun run test               # all vitest_*.ts files (no agentId set)
bun run test:agent         # vitest_agent.ts            → agentId=demo-support-bot
bun run test:banking       # vitest_banking_agent.ts    → agentId=demo-banking-bot
bun run test:generated     # vitest_generated_agent.ts  → agentId=demo-pizza-bot
bun run runner             # bun_runner.ts — Bun HTTP server wrapping startVitest
```

Each script tags the run with a distinct `AGENT_OBSERVABILITY_AGENT_ID`
so the three examples show up as separate agents on the dashboard.
Override by prefixing your own: `AGENT_OBSERVABILITY_AGENT_ID=my-bot bun run test:agent`.

> Do **not** invoke the files directly with `bun run vitest_agent.ts` or
> `node vitest_agent.ts`. Vitest's `describe`/`it` depend on the
> per-worker state the `vitest` CLI sets up, so direct execution throws
> `Vitest failed to access its internal state`.

## Required env vars

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | LLM for the agent-under-test and the judge model. These examples call OpenAI directly via `@livekit/agents-plugin-openai`, so you do **not** need `LIVEKIT_API_KEY` — that's only for LiveKit Cloud's inference gateway. |
| `AGENT_OBSERVABILITY_URL` | e.g. `http://localhost:9090` — when set, the reporter uploads the run. Omit to run locally without uploading. |
| `AGENT_OBSERVABILITY_USER` / `AGENT_OBSERVABILITY_PASS` | Basic auth, if the server has it configured. |
| `AGENT_OBSERVABILITY_AGENT_ID` | Agent id shown in the dashboard. Each `bun run test:*` script sets this to a distinct value (see above). If you invoke vitest directly without one of those scripts, no agent id is tagged. |
| `AGENT_OBSERVABILITY_GENERATED_N` | `vitest_generated_agent.ts` only — how many scenarios the LLM should generate. Defaults to 10. |

## Plugin link

`package.json` pulls the reporter via `"vitest-agent-observability":
"file:../../vitest-agent-observability"`, so `bun run build` inside
`../../vitest-agent-observability` picks up immediately after a
`bun install` here.
