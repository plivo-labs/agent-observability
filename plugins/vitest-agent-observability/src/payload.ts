import { createRequire } from "node:module";
import type { EvalPayloadV0, EvalCase } from "./types.js";
import type { RunCollector } from "./collector.js";

const require = createRequire(import.meta.url);

export const FRAMEWORK = "vitest";
export const SDK = "livekit-agents";

export function buildPayload(opts: {
  collector: RunCollector;
  agentId?: string | null;
  accountId?: string | null;
  finishedAt: number;
}): EvalPayloadV0 {
  const { collector, agentId, accountId, finishedAt } = opts;
  return {
    version: "v0",
    run: {
      run_id: collector.run_id,
      account_id: accountId ?? null,
      agent_id: agentId ?? null,
      framework: FRAMEWORK,
      framework_version: pkgVersion("vitest") ?? undefined,
      sdk: SDK,
      sdk_version: pkgVersion("@livekit/agents") ?? undefined,
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
