# vitest-agent-observability

Vitest reporter that uploads LiveKit-agents eval results to
[agent-observability](https://github.com/plivo-labs/agent-observability).

Each `vitest run` becomes one `eval_run` in the dashboard; every `it(...)` test
shows up as an `eval_case` with events, judgments, and failure detail.

## Install

```bash
npm install -D vitest-agent-observability
```

Requires Node 18+ and `vitest >= 1.0`. `@livekit/agents` is optional — the
reporter works for plain Vitest suites too.

## Configure

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import AgentObservability from 'vitest-agent-observability';

export default defineConfig({
  test: {
    setupFiles: ['vitest-agent-observability/setup'],
    reporters: [
      'default',
      new AgentObservability({
        // Optional — falls back to AGENT_OBSERVABILITY_URL env var.
        // url: 'http://localhost:9090',
        agentId: 'support-bot',
      }),
    ],
  },
});
```

The `setupFiles` entry registers an `afterEach` hook that flushes captured
`RunResult`/judgment data into `task.meta`. Without it, nothing will be
uploaded from tests running in worker pools.

## Use inside a test

```ts
import { describe, it } from 'vitest';
import { Agent, AgentSession, inference } from '@livekit/agents';
import { captureRunResult } from 'vitest-agent-observability';

class Assistant extends Agent {
  constructor() { super({ instructions: 'Be helpful.' }); }
}

describe('Assistant', () => {
  it('greets politely', async () => {
    const llm = new inference.LLM({ model: 'openai/gpt-4.1-mini' });
    const session = new AgentSession({ llm });
    await session.start({ agent: new Assistant() });

    const result = captureRunResult(
      await session.run({ userInput: 'Hello' }),
    );

    result.expect.nextEvent().isMessage({ role: 'assistant' });
    await result.expect.nextEvent({ type: 'message' }).judge(llm, {
      intent: 'greets politely',
    });
  });
});
```

**Auto-capture is on by default.** The plugin monkey-patches
`AgentSession.prototype.run` so every `RunResult` flows into the collector
automatically — in practice you rarely need to call `captureRunResult(...)`
at all. The wrapper remains exported for RunResults produced outside the
standard `.run()` path, and it's idempotent so calling it on an
already-captured result is a no-op.

`.judge(...)` calls on LiveKit's assertion API are intercepted
automatically. Verdict, intent, and reasoning are recorded as a first-class
Judgment event in the dashboard.

> **Python users:** the mirror plugin
> [`pytest-agent-observability`](../pytest-agent-observability/) exposes
> the same behavior. The manual helper is named `capture(result)` there
> (vs. `captureRunResult(result)` here); the auto-capture and `.judge()`
> interception are identical across both sides.

## Configuration

| Env var | Reporter option | Purpose |
|---|---|---|
| `AGENT_OBSERVABILITY_URL` | `url` | Base URL of the server |
| `AGENT_OBSERVABILITY_AGENT_ID` | `agentId` | Free-form agent identifier |
| `AGENT_OBSERVABILITY_ACCOUNT_ID` | `accountId` | Multi-tenant account id |
| `AGENT_OBSERVABILITY_USER` | `basicAuth.user` | Basic-auth user (when server enables auth) |
| `AGENT_OBSERVABILITY_PASS` | `basicAuth.pass` | Basic-auth password |

CI metadata (GitHub Actions / GitLab / CircleCI / Buildkite) is auto-detected.

## Behavior

- One `POST /observability/evals/v0` at `onFinished`.
- 10-second timeout, 3 retries with exponential backoff.
- On total failure, payload is written to
  `.vitest-cache/agent-observability/<run_id>.json` and logged.
- Never throws — upload issues won't fail your test suite.

## Running evals from a server

You can invoke Vitest programmatically from a Bun or Node HTTP server so
your evals run on demand — useful for CI webhooks, scheduled runs, or an
internal "re-grade this agent" button. The reporter attaches the same
way it does on the CLI, so each HTTP-triggered run lands in the
dashboard as its own `eval_run`.

Use `startVitest` from `vitest/node`:

```ts
import { startVitest } from "vitest/node";
import type { Reporter } from "vitest/node";

// Minimal in-memory reporter — collects per-case outcomes for the API
// response. The observability reporter from vitest.config.ts still runs
// alongside this one and uploads to the dashboard.
class JsonReporter implements Reporter {
  cases: Array<{ name: string; state: string; ms: number }> = [];
  onTestFinished(test: any) {
    this.cases.push({
      name: test.name,
      state: test.result?.state ?? "unknown",
      ms: test.result?.duration ?? 0,
    });
  }
}

Bun.serve({
  port: 8080,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/run") {
      return new Response(null, { status: 404 });
    }
    const { files } = (await req.json()) as { files: string[] };
    const reporter = new JsonReporter();
    const vitest = await startVitest(
      "test",
      files,
      { watch: false, run: true, reporters: [reporter] },
    );
    // `run: true` runs to completion, but some Vitest versions queue the
    // run async — awaiting close() guarantees the reporter is drained.
    await vitest?.close();
    return Response.json({ cases: reporter.cases });
  },
});
```

Notes:

- `startVitest("test", files, overrides)` loads the project's
  `vitest.config.ts`, so the `vitest-agent-observability` reporter from
  the config attaches automatically. Any extra reporters you pass in the
  third argument run *in addition to* the configured ones.
- `startVitest` spawns worker threads. You can't run two concurrent
  invocations in the same process — Vitest's internal state collides.
  For a throughput-oriented server, either queue requests or spawn a
  subprocess per run (e.g. `Bun.spawn`). For a developer-facing
  "trigger a run" endpoint, in-process is fine.
- Set the upload env vars (`AGENT_OBSERVABILITY_URL`, optional basic
  auth, etc.) on the server process — the reporter reads them once per
  run.

A working reference server with both `/run/vitest` (full Vitest run)
and `/run/scenarios` (bypasses Vitest, calls the scenario runner
directly) lives at
[`plugins/examples/vitest/bun_runner.ts`](../examples/vitest/bun_runner.ts).
Its Python mirror using `pytest.main()` from FastAPI is at
[`plugins/examples/pytest/fastapi_runner.py`](../examples/pytest/fastapi_runner.py).

## Development

```bash
cd plugins/vitest-agent-observability
npm install
npm test
npm run build
```

## Releasing

Publishing is PR-label triggered — no manual tags or releases.

1. Bump `version` in `plugins/vitest-agent-observability/package.json` in
   a dedicated PR (no feature changes in the same PR).
2. Apply labels:
   - `release-vitest-plugin` — trigger: publishes to npm on merge.
   - `vitest-agent-observability` — (on feature/fix PRs only) filter:
     include this PR in the next release's notes.
3. Merge to `main`. `Tests` runs, then `Publish vitest-agent-observability`
   picks up the merged commit, builds `plugins/vitest-agent-observability`
   with `tsc`, publishes to npm using the `NPM_TOKEN` repo secret, and
   creates a `vitest-plugin-v<version>` GitHub Release with notes listing
   every `vitest-agent-observability`-labeled PR merged since the
   previous `vitest-plugin-v*` tag.

Prerequisite (one-time): `NPM_TOKEN` (an npm automation token with
publish rights for `vitest-agent-observability`) must be set as a
repository Actions secret.
