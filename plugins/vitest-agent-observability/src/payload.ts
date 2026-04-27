import { createRequire } from "node:module";
import type { EvalPayloadV0 } from "./types.js";
import type { RunCollector } from "./collector.js";

const require = createRequire(import.meta.url);

/** Test framework that ran this suite — `vitest`. Constant. */
export const TESTING_FRAMEWORK = "vitest";

/**
 * Probe the installed agent-framework packages to identify which one
 * the agent under test is built with. Returns a `{ name, version }`
 * pair, or `null` when nothing detectable is installed.
 *
 * Pipecat has no Node SDK, so only LiveKit is probed on this side.
 * The pytest plugin probes both `livekit-agents` and `pipecat-ai`.
 */
const AGENT_FRAMEWORK_PROBES: Array<{ name: string; pkg: string }> = [
  { name: "livekit", pkg: "@livekit/agents" },
];

export function detectFramework(): { name: string; version: string | null } | null {
  for (const probe of AGENT_FRAMEWORK_PROBES) {
    const v = pkgVersion(probe.pkg);
    if (v != null) return { name: probe.name, version: v };
  }
  return null;
}

export function buildPayload(opts: {
  collector: RunCollector;
  agentId?: string | null;
  accountId?: string | null;
  finishedAt: number;
}): EvalPayloadV0 {
  const { collector, agentId, accountId, finishedAt } = opts;
  const framework = detectFramework();
  return {
    version: "v0",
    run: {
      run_id: collector.run_id,
      account_id: accountId ?? null,
      agent_id: agentId ?? null,
      framework: framework?.name ?? null,
      framework_version: framework?.version ?? null,
      testing_framework: TESTING_FRAMEWORK,
      testing_framework_version: pkgVersion("vitest") ?? null,
      started_at: collector.started_at,
      finished_at: finishedAt,
      ci: (collector.ci as any) ?? null,
    },
    cases: collector.cases.slice(),
  };
}

function pkgVersion(name: string): string | null {
  try {
    const pkg = require(`${name}/package.json`);
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
