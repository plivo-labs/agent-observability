/**
 * Vitest setup module. Add to your `vitest.config.ts`:
 *
 *   test: {
 *     setupFiles: ['vitest-agent-observability/setup'],
 *     reporters: ['default', new AgentObservability()],
 *   }
 *
 * This registers an `afterEach` hook that drains the per-test capture bucket
 * into `task.meta.agentObs` so the reporter (running in the main process)
 * can read it.
 */

import { afterEach } from "vitest";
import { flushTaskMeta } from "./collector.js";

afterEach((ctx) => {
  flushTaskMeta(ctx as any);
});
