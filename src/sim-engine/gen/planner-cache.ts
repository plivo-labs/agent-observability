// Planner-output cache. The planner is a pure function of its inputs (flow JSON,
// mode, cap, instructions, existing-scenario summaries, model) and is by far the
// slowest generation phase (~50s on a reasoning model). The Vibe Agent's
// rerun-failed loop calls generate repeatedly on the SAME flow with byte-identical
// planner inputs — every rerun re-paid the full planning cost for a plan that is
// deterministic given the inputs.
//
// Correctness stance: the key is a sha256 over the EXACT planner inputs, so a hit
// can only ever reuse the output of a byte-identical request — quality is provably
// unchanged (and rerun coverage becomes MORE stable: the same smoke units survive
// across the vibe loop instead of re-planning churn). A false miss merely costs a
// planner call. Entries are stored SERIALIZED and re-parsed on every hit so no two
// generations ever share (and possibly mutate) the same object graph.
//
// Pure module: no config imports (the TTL is passed by the caller — the route wires
// SIM_GEN_PLANNER_CACHE_TTL_MS; direct callers/tests default to 0 = disabled).
// Process-local by design: AO runs 1-2 API tasks and a miss is only a slow path.
import { createHash } from "node:crypto"; // deterministic builtin — the config-free contract holds
import type { PlannerWithInventory, ExistingScenarioSummary, SimulationMode } from "./types.js";
import type { WireReasoningEffort } from "../../llm/types.js";

const MAX_ENTRIES = 50;

interface Entry {
  serialized: string;
  at: number;
}

// Map iteration order = insertion order → FIFO eviction.
const store = new Map<string, Entry>();

export interface PlannerCacheKeyParts {
  flowJson: unknown;
  phloUuid: string;
  model: string;
  /**
   * Planner reasoning effort — part of the key because it changes the plan the LLM
   * produces, so a cached entry from one effort setting must not be served to
   * another. This matters most while A/B-ing the dial: without it, flipping
   * SIM_EVAL_PLANNER_REASONING_EFFORT and re-generating the same flow inside the
   * cache TTL would silently return the PREVIOUS arm's plan and the comparison
   * would measure nothing. `undefined` (effort omitted) is its own key value.
   */
  reasoningEffort: WireReasoningEffort | undefined;
  simulationMode: SimulationMode;
  smokeCap: number;
  instructions: string;
  existingSummaries: ExistingScenarioSummary[];
}

/** sha256 over the exact planner inputs. JSON.stringify key-order differences can
 *  only cause false MISSES (safe), never false hits. */
export function plannerCacheKey(parts: PlannerCacheKeyParts): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function plannerCacheGet(key: string, ttlMs: number): PlannerWithInventory | null {
  if (ttlMs <= 0) return null;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) {
    store.delete(key);
    return null;
  }
  return JSON.parse(entry.serialized) as PlannerWithInventory;
}

/** Store (or refresh) a plan. Callers store only AFTER allocation succeeds, so a
 *  cached plan is never one the allocator rejects. Refreshing on every success
 *  makes the TTL SLIDING (a plan in active rerun use stays warm) — safe because
 *  the key is deterministic in the inputs. */
export function plannerCacheSet(key: string, planner: PlannerWithInventory): void {
  store.delete(key); // re-insert to refresh FIFO position + timestamp
  store.set(key, { serialized: JSON.stringify(planner), at: Date.now() });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
}

/** Invalidate (allocator failure → the plan under this key is poisoned; the
 *  replanned successor is re-stored after it passes allocation). */
export function plannerCacheDelete(key: string): void {
  store.delete(key);
}

/** Test hook. */
export function plannerCacheClear(): void {
  store.clear();
}
