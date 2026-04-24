/**
 * Monkey-patch `AgentSession.prototype.run` so every `RunResult` flows
 * into the collector automatically — users don't need to wrap every call
 * with `captureRunResult(...)`. Mirrors the pytest plugin's auto-capture
 * wrapper so both ecosystems feel the same.
 *
 * `captureRunResult(runResult)` remains exported for advanced users and is
 * idempotent: calling it on a RunResult already captured by the wrapper
 * does nothing.
 *
 * Safe if `@livekit/agents` isn't installed — the dynamic import fails
 * and this silently no-ops.
 */

import { captureRunResult } from "./collector.js";
import type { Logger } from "./uploader.js";

const PATCH_FLAG = Symbol.for("agent_observability.run_patched");

export async function installAutocaptureWrapper(
  logger?: Logger,
): Promise<(() => void) | null> {
  const target = await findAgentSessionClass();
  if (!target) return null;
  const { cls, original } = target;

  // Idempotent — the module may be imported more than once per worker
  // (setup file + user test). A second install is a no-op.
  if ((cls.prototype.run as any)?.[PATCH_FLAG]) return null;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    // The real `run()` returns a RunResult synchronously (not a
    // Promise). Capture immediately; dedup handles the case where the
    // user also calls `captureRunResult(...)` explicitly.
    try {
      captureRunResult(result);
    } catch {
      // Never let a capture error interfere with the test's own call.
    }
    return result;
  };
  (wrapped as any)[PATCH_FLAG] = true;
  cls.prototype.run = wrapped;
  logger?.warn?.("[agent-observability] AgentSession.run auto-capture installed");

  return () => {
    cls.prototype.run = original;
  };
}

async function findAgentSessionClass(): Promise<{
  cls: { prototype: { run: Function } };
  original: Function;
} | null> {
  const candidates = [
    "@livekit/agents",
    "@livekit/agents/voice",
    "@livekit/agents/voice/agent_session",
  ];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const cls = findAgentSession(mod);
      const run = cls?.prototype?.run;
      if (cls && typeof run === "function") {
        return { cls, original: run };
      }
    } catch {
      // Keep trying other import paths.
    }
  }
  return null;
}

function findAgentSession(mod: any): any | null {
  if (!mod) return null;
  if (mod.AgentSession) return mod.AgentSession;
  const voice = mod.voice;
  if (voice?.AgentSession) return voice.AgentSession;
  const def = mod.default;
  if (def?.AgentSession) return def.AgentSession;
  if (def?.voice?.AgentSession) return def.voice.AgentSession;
  return null;
}
