import { defineConfig } from 'vitest/config'
import AgentObservability from 'vitest-agent-observability'

// Vitest config for the example eval suites. `setupFiles` registers the
// plugin's afterEach hook that flushes captured events; the reporter
// uploads each run to agent-observability when AGENT_OBSERVABILITY_URL
// is set.
//
// Env vars:
//   AGENT_OBSERVABILITY_URL   (e.g. http://localhost:9090)
//   AGENT_OBSERVABILITY_USER  (optional, if the server has basic auth)
//   AGENT_OBSERVABILITY_PASS  (optional)
//   OPENAI_API_KEY            (required for the agent examples)
export default defineConfig({
  test: {
    // Match the example filenames (`vitest_agent.ts`, etc.) on top of the
    // default `*.test.ts` / `*.spec.ts` patterns.
    include: ['**/vitest_*.ts', '**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    setupFiles: [
      // Initializes the @livekit/agents pino logger. Must run before any
      // AgentSession is constructed.
      './setup.ts',
      'vitest-agent-observability/setup',
    ],
    reporters: [
      'default',
      // agentId is authoritative from the environment. Each example
      // script in package.json sets its own distinct value so runs show
      // up as separate agents on the dashboard.
      new AgentObservability({
        agentId: process.env.AGENT_OBSERVABILITY_AGENT_ID,
      }),
    ],
    // Example agents can take a while to run against real LLMs.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
