/**
 * Vitest setup module. Add to your `vitest.config.ts`:
 *
 *   test: {
 *     setupFiles: ['vitest-agent-observability/setup'],
 *     reporters: ['default', new AgentObservability()],
 *   }
 *
 * This registers:
 *   - An `afterEach` hook that drains the per-test capture bucket into
 *     `task.meta.agentObs` so the reporter (running in the main process)
 *     can read it.
 *   - The judge() monkey-patch inside the Vitest worker. The reporter's
 *     onInit hook runs in the main process, which has its own module
 *     cache — patching the LiveKit prototype there has no effect on the
 *     worker threads where tests actually run. Installing from a setup
 *     file fires once per worker at the right time.
 */

import { afterEach } from "vitest";
import { flushTaskMeta } from "./collector.js";
import { installJudgeWrapper } from "./judge.js";
import { installAutocaptureWrapper } from "./autocapture.js";

afterEach((ctx) => {
  flushTaskMeta(ctx as any);
});

// Top-level await: vitest loads setup files before any test file, so by
// the time a test imports @livekit/agents the shared module instance
// already carries the patched prototype. If the SDK isn't installed, both
// wrappers silently no-op.
await installJudgeWrapper();
await installAutocaptureWrapper();
