import fs from "node:fs";
import path from "node:path";
import type { EvalPayloadV0 } from "./types.js";
import type { RunCollector } from "./collector.js";

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
  agentName?: string | null;
  accountId?: string | null;
  finishedAt: number;
}): EvalPayloadV0 {
  const { collector, agentId, agentName, accountId, finishedAt } = opts;
  const framework = detectFramework();
  return {
    version: "v0",
    run: {
      run_id: collector.run_id,
      account_id: accountId ?? null,
      agent_id: agentId ?? null,
      agent_name: agentName ?? null,
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

/**
 * Walk up the directory tree from `process.cwd()` until we find a
 * `node_modules/<name>/package.json`, then return its `version`.
 *
 * Why not `createRequire(import.meta.url)`: when the plugin is installed
 * via a `file:` dep (common for in-tree dev), bun symlinks it back to the
 * source directory, so `import.meta.url` lives outside the consumer's
 * node_modules tree and the standard require lookup walks up the wrong
 * branch. Why not `createRequire(process.cwd())` either: the user might
 * invoke vitest from the repo root rather than the package dir, in which
 * case the consumer's `node_modules` is several levels down. This walk
 * is invariant to invocation cwd within the consumer's tree.
 */
function pkgVersion(name: string): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8")) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not present here, walk up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
