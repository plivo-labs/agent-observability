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

`captureRunResult(result)` attaches the RunResult to the current test.
`.judge(...)` calls on LiveKit's assertion API are intercepted automatically.

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

## Development

```bash
cd plugins/vitest-agent-observability
npm install
npm test
npm run build
```
