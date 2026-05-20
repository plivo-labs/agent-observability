# agent-observability-sdk (Node)

The Node SDK for shipping evals + telemetry to
[agent-observability](https://github.com/plivo-labs/agent-observability).
Two surfaces in one install:

- **LiveKit helpers** — `initObservability`, `ensureObservabilityUrl`.
  Bootstrap the tag bundle the v2 server expects from raw-LiveKit Node
  workers. (agent-transport's `AudioStreamServer` already does this
  internally; you only need these helpers when you drive LiveKit Agents
  directly.)
- **Vitest reporter** — auto-registered when you list it in
  `vitest.config.ts`. Every `vitest run` becomes one `eval_run` in the
  dashboard; every `it(...)` becomes an `eval_case` with events,
  judgments, and failure detail.

> **No judges yet.** The Python sibling ships nine LiveKit-compatible
> judges, but LiveKit Node Agents 1.3.0 has no Judge API. Judges land
> on the Node side once LiveKit catches up.

## Install

```bash
npm install -D agent-observability-sdk
```

Vitest is an optional peer dependency — only required if you use the
reporter. Node ≥ 18.

## Quick start

### 1. Raw LiveKit Node worker

```ts
import { initObservability } from "agent-observability-sdk/livekit";
import { AgentServer } from "@livekit/agents";

const server = new AgentServer();

server.rtcSession({ agentName: "support-bot" }, async (ctx) => {
  initObservability(ctx.tagger, {
    agentId: "9c2f7e3d-…",
    agentName: "support-bot",
    accountId: "acct-7",
    transport: "text",
  });
  // …your usual AgentSession.start(...) wiring
});
```

`initObservability` throws if `LIVEKIT_OBSERVABILITY_URL` (or the
fallback `AGENT_OBSERVABILITY_URL`) is unset — there is no point
continuing if the session report has nowhere to go. Use
`ensureObservabilityUrl()` directly for a non-fatal warn-only contract.

### 2. Vitest reporter

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import AgentObservability from "agent-observability-sdk/livekit/vitest";

export default defineConfig({
  test: {
    setupFiles: ["agent-observability-sdk/livekit/vitest/setup"],
    reporters: ["default", new AgentObservability()],
  },
});
```

```bash
export AGENT_OBSERVABILITY_URL=https://obs.example.com
export AGENT_OBSERVABILITY_AGENT_ID=9c2f7e3d-…
vitest run
```

Inside a test, `captureRunResult` and `.judge()` interception are
automatic. The helper is exported for results born outside the standard
`session.run(...)` path:

```ts
import { captureRunResult } from "agent-observability-sdk/livekit/vitest";

it("greets politely", async () => {
  const result = captureRunResult(await session.run({ userInput: "Hello" }));
  result.expect.nextEvent().isMessage({ role: "assistant" });
});
```

## Configuration

| Env var | Purpose |
|---|---|
| `LIVEKIT_OBSERVABILITY_URL` | Dashboard base URL (LiveKit-canonical name). Required by `initObservability` (throws if unset). |
| `AGENT_OBSERVABILITY_URL` | Same purpose; `initObservability` accepts this as a fallback and mirrors it into `LIVEKIT_OBSERVABILITY_URL` so LiveKit's upload code picks it up. |
| `AGENT_OBSERVABILITY_AGENT_ID` | Stable opaque agent identifier. Required on every upload. UUIDs strongly recommended over slugs. |
| `AGENT_OBSERVABILITY_ACCOUNT_ID` | Multi-tenant account id. Optional. |
| `AGENT_OBSERVABILITY_USER` / `_PASS` | Basic-auth credentials when the server enables auth. |
| `AGENT_OBSERVABILITY_TIMEOUT` | Upload request timeout in seconds (default `10`). |
| `AGENT_OBSERVABILITY_MAX_RETRIES` | Max upload attempts before falling back (default `3`). |
| `AGENT_OBSERVABILITY_FALLBACK_DIR` | Directory for failed-upload JSON (defaults to `.vitest-cache/agent-observability`). |

CI metadata (GitHub / GitLab / CircleCI / Buildkite) is auto-detected
by the Vitest reporter from standard env vars.

## Migrating from `vitest-agent-observability`

The standalone `vitest-agent-observability` package is **discontinued**.
The last published release (0.2.1) still installs but predates this
SDK's helpers (`initObservability`, `ensureObservabilityUrl`). Switch
to this SDK to pick those up + future fixes:

```diff
-import AgentObservability from 'vitest-agent-observability';
+import AgentObservability from 'agent-observability-sdk/livekit/vitest';
```

```diff
 // vitest.config.ts
 test: {
-  setupFiles: ['vitest-agent-observability/setup'],
+  setupFiles: ['agent-observability-sdk/livekit/vitest/setup'],
 },
```

```diff
-vitest-agent-observability
+agent-observability-sdk
```

Reporter behaviour, auto-capture, `.judge(...)` interception, retry /
fallback, and CI metadata extraction are byte-for-byte identical.

## License

MIT
