import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import { planCapabilities } from "./planner.js";
import { allocateScenarioSlots } from "./allocator.js";
import { allocateSmokeSlots } from "./smoke-allocator.js";
import { writeScenarioChunk } from "./writer.js";
import { WRITER_CHUNK_SIZE, WRITER_CHUNK_RETRIES, WRITER_SLOT_RETRIES, SMOKE_CAP_FALLBACK } from "./combos.js";
import type { Slot, RuntimeScenario, PlannerWithInventory, ExistingScenarioSummary, SimulationMode } from "./types.js";

// AO Simulation Engine — generation orchestration (Phase 1.6).
// Port of the orchestrator service `generate_scenarios_stream`: PLANNER (2 attempts) → deterministic
// ALLOCATOR (2 attempts, replan on the 2nd) → WRITER (chunks of 10, parallel, with
// chunk + per-slot fallback retries) → dedup by coverage_key. Yields progress events
// + scenarios as a discriminated union (the Phase 4 route layer maps these to SSE).
//
// V1 simplification: non-streaming writer chunks (parallel via Promise.all), deferring
// the orchestrator service's token-streaming recovery — same schema, validation, retries, and events.

type Dict = Record<string, any>;

export type GenEvent =
  | { type: "planning_started"; attempt: number; existing_summary_count: number }
  | { type: "planning_done"; attempt: number; capability_count: number }
  | { type: "allocation_started"; attempt: number; capability_count: number }
  | { type: "allocation_done"; attempt: number; planned_count: number }
  | { type: "writing_started"; planned_count: number; chunk_count: number; chunk_size: number }
  | { type: "writer_chunk_done"; chunk_index: number; chunk_count: number; chunk_saved_count: number; failed_slot_ids: string[] }
  | { type: "writer_scenario_done"; chunk_index: number; chunk_count: number; scenario_index: number; saved_count: number; slot_id: string }
  | { type: "scenario"; scenario: RuntimeScenario }
  | { type: "metadata"; metadata: GenMetadata };

export interface GenMetadata {
  requested_count: number;
  planned_count: number;
  saved_count: number;
  failed_count: number;
  failed_slot_ids: string[];
  /** Scenarios written but dropped as duplicates — coverage_key for stress (the
   *  allocator's feasibility fallback can legitimately reuse a key), smoke_unit_id for
   *  smoke (units under one capability legitimately share all coverage axes). Keeps the
   *  ledger self-consistent: planned = saved + failed + deduped. */
  deduped_count: number;
  partial_success: boolean;
  planner_usage: LlmUsage | null;
  writer_usages: LlmUsage[];
  /** Smoke-mode only (aiassist metadata parity, minus its unconsumed
   *  expected_smoke_unit_ids): the effective unit cap, the stable hash over the
   *  surviving unit_ids (coverage-drift detection), and any planner units dropped
   *  as over-cap overflow. Absent for stress runs. */
  smoke_cap?: number;
  smoke_units_hash?: string;
  dropped_unit_ids?: string[];
}

export interface GenerateInput {
  /** Canonical flow (the caller runs parseFlowJson/normalizeFlow first). */
  flowJson: Dict;
  phloUuid: string;
  maxScenarios: number;
  model: string;
  simulationMode?: SimulationMode;
  testCaseGenerationInstructions?: string;
  existingSummaries?: ExistingScenarioSummary[];
  /** Callers must pre-clamp to SMOKE_CAP_HARD — only the HTTP route does (the gen
   *  pipeline is config-free by design, so the env-tunable hard cap can't live here;
   *  the Python reference clamps inside the generator instead). */
  smokeCap?: number;
  /** Caller abort (the SSE client disconnected) — checked between phases and threaded into
   *  every LLM call so an abandoned request stops burning tokens and frees its gen slot. */
  signal?: AbortSignal;
  // Test injection.
  plannerProvider?: LlmProvider;
  writerProvider?: LlmProvider;
}

const PLANNER_RETRIES = 2;
const ALLOCATION_RETRIES = 2;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** One chunk through the writer with chunk-level + per-slot fallback retries. */
async function runChunkWithRetry(
  base: { flowJson: Dict; planner: PlannerWithInventory; model: string; generationId: string; phloUuid: string; chunkIndex: number; provider?: LlmProvider; signal?: AbortSignal },
  slots: Slot[],
): Promise<{ scenarios: RuntimeScenario[]; failedSlotIds: string[]; usages: LlmUsage[] }> {
  const scenarios: RuntimeScenario[] = [];
  const usages: LlmUsage[] = [];
  let remaining = slots;

  for (let attempt = 1; attempt <= WRITER_CHUNK_RETRIES + 1 && remaining.length > 0; attempt++) {
    const res = await writeScenarioChunk({ ...base, slots: remaining, attempt });
    scenarios.push(...res.scenarios);
    usages.push(res.usage);
    const got = new Set(res.scenarios.map((s) => s.eval_metadata?.slot_id));
    remaining = remaining.filter((s) => !got.has(s.slot_id));
  }

  // Per-slot fallback: retry each still-missing slot on its own.
  const stillFailed: string[] = [];
  for (const slot of remaining) {
    let done = false;
    for (let attempt = 1; attempt <= WRITER_SLOT_RETRIES + 1 && !done; attempt++) {
      const res = await writeScenarioChunk({ ...base, slots: [slot], attempt });
      usages.push(res.usage);
      if (res.scenarios.length > 0) {
        scenarios.push(...res.scenarios);
        done = true;
      }
    }
    if (!done) stillFailed.push(slot.slot_id);
  }
  return { scenarios, failedSlotIds: stillFailed, usages };
}

export async function* generateScenarios(input: GenerateInput): AsyncGenerator<GenEvent> {
  const mode: SimulationMode = input.simulationMode ?? "stress";
  // Effective smoke-unit cap. The route resolves it from the request/env (clamped to
  // SMOKE_CAP_HARD); the fallback covers direct callers/tests so the planner is never
  // told "emit at most 0 units". Stays 0 for stress (unused there).
  const smokeCap = mode === "smoke" ? Math.max(1, input.smokeCap ?? SMOKE_CAP_FALLBACK) : 0;
  const existing = input.existingSummaries ?? [];
  const generationId = crypto.randomUUID();
  let instructions = input.testCaseGenerationInstructions ?? "";

  // ── PLANNER (2 attempts) ──────────────────────────────────────────────────────
  let planner: PlannerWithInventory | null = null;
  let plannerUsage: LlmUsage | null = null;
  for (let attempt = 1; attempt <= PLANNER_RETRIES; attempt++) {
    input.signal?.throwIfAborted();
    yield { type: "planning_started", attempt, existing_summary_count: existing.length };
    try {
      const out = await planCapabilities({
        flowJson: input.flowJson,
        phloUuid: input.phloUuid,
        model: input.model,
        existingSummaries: existing,
        userInstructions: instructions,
        simulationMode: mode,
        smokeCap,
        provider: input.plannerProvider,
        signal: input.signal,
      });
      planner = out.planner;
      plannerUsage = out.usage;
      yield { type: "planning_done", attempt, capability_count: planner.capabilities.length };
      break;
    } catch (e) {
      if (attempt >= PLANNER_RETRIES) throw new Error(`Planner failed after ${PLANNER_RETRIES} attempts: ${(e as Error).message}`);
    }
  }
  if (!planner) throw new Error("Planner produced no output");

  // ── ALLOCATOR (2 attempts; replan on the 2nd) ──────────────────────────────────
  let slots: Slot[] | null = null;
  // Smoke-mode metadata extras (aiassist parity) — captured from the smoke allocation.
  let smokeUnitsHashOut: string | undefined;
  let droppedUnitIds: string[] | undefined;
  for (let attempt = 1; attempt <= ALLOCATION_RETRIES; attempt++) {
    yield { type: "allocation_started", attempt, capability_count: planner.capabilities.length };
    try {
      if (mode === "smoke") {
        const result = allocateSmokeSlots({ planner, smokeCap });
        slots = result.slots;
        smokeUnitsHashOut = result.smoke_units_hash;
        droppedUnitIds = result.dropped_unit_ids;
      } else {
        const result = allocateScenarioSlots(planner, input.maxScenarios, existing);
        slots = result.slots;
      }
      yield { type: "allocation_done", attempt, planned_count: slots.length };
      break;
    } catch (e) {
      if (attempt >= ALLOCATION_RETRIES) throw new Error(`Allocator failed after ${ALLOCATION_RETRIES} attempts: ${(e as Error).message}`);
      // Replan with the allocator error appended to the instructions. In smoke mode the
      // dominant failure is a planner that omitted smoke_units — say so explicitly (aiassist parity).
      const retryHint =
        mode === "smoke"
          ? `[allocator retry] ${(e as Error).message}. You MUST emit smoke_units under each capability.`
          : `[allocator retry] ${(e as Error).message}`;
      instructions = `${instructions}\n\n${retryHint}`.trim();
      const out = await planCapabilities({
        flowJson: input.flowJson,
        phloUuid: input.phloUuid,
        model: input.model,
        existingSummaries: existing,
        userInstructions: instructions,
        simulationMode: mode,
        smokeCap,
        provider: input.plannerProvider,
        signal: input.signal,
      });
      planner = out.planner;
    }
  }
  if (!slots) throw new Error("Allocator produced no slots");

  // ── WRITER (parallel chunks + retries) ─────────────────────────────────────────
  input.signal?.throwIfAborted();
  const chunks = chunk(slots, WRITER_CHUNK_SIZE);
  yield { type: "writing_started", planned_count: slots.length, chunk_count: chunks.length, chunk_size: WRITER_CHUNK_SIZE };

  // Each chunk is isolated: a thrown chunk (LlmError after completeJSON's own retries —
  // sustained 429, timeout, twice-invalid JSON) degrades to "all its slots failed" instead of
  // rejecting Promise.all, which would discard every OTHER chunk's already-written scenarios
  // and turn a partial success into a total failure.
  const results = await Promise.all(
    chunks.map((c, i) =>
      runChunkWithRetry(
        { flowJson: input.flowJson, planner: planner!, model: input.model, generationId, phloUuid: input.phloUuid, chunkIndex: i, provider: input.writerProvider, signal: input.signal },
        c,
      ).catch((err): { scenarios: RuntimeScenario[]; failedSlotIds: string[]; usages: LlmUsage[] } => {
        // A caller abort is not a chunk failure — rethrow so the whole generation stops.
        if (input.signal?.aborted) throw err;
        console.error(`[sim-gen] writer chunk ${i} failed (generation ${generationId}): ${(err as Error).message}`);
        return { scenarios: [], failedSlotIds: c.map((s) => s.slot_id), usages: [] };
      }),
    ),
  );

  // Emit per-chunk + per-scenario events, dedup by smoke_unit_id (smoke) / coverage_key (stress).
  const writerUsages: LlmUsage[] = [];
  const failedSlotIds: string[] = [];
  const seenCoverage = new Set<string>();
  let saved = 0;
  let deduped = 0;
  for (let chunkIndex = 0; chunkIndex < results.length; chunkIndex++) {
    const r = results[chunkIndex];
    writerUsages.push(...r.usages);
    failedSlotIds.push(...r.failedSlotIds);
    let chunkSaved = 0;
    for (let i = 0; i < r.scenarios.length; i++) {
      const scenario = r.scenarios[i];
      // Smoke units under one capability legitimately share all 8 coverage axes (same
      // kind + route ⇒ identical coverage_key), so dedup smoke by the audit-unique
      // smoke_unit_id; stress keeps coverage_key (its allocator guarantees uniqueness).
      const key = scenario.eval_metadata?.smoke_unit_id || scenario.eval_metadata?.coverage_key || "";
      if (key && seenCoverage.has(key)) {
        deduped += 1; // counted so the shortfall is visible in metadata, not silent
        continue;
      }
      if (key) seenCoverage.add(key);
      saved += 1;
      chunkSaved += 1;
      yield { type: "scenario", scenario };
      yield { type: "writer_scenario_done", chunk_index: chunkIndex, chunk_count: chunks.length, scenario_index: i, saved_count: saved, slot_id: scenario.eval_metadata?.slot_id ?? "" };
    }
    yield { type: "writer_chunk_done", chunk_index: chunkIndex, chunk_count: chunks.length, chunk_saved_count: chunkSaved, failed_slot_ids: r.failedSlotIds };
  }

  // All-failed: every planned slot failed and nothing was saved. Throw (the route's
  // catch emits an SSE `error` event) instead of a `completed`/metadata event — mirrors
  // aiassist, which emits `type:"error"` and no `completed` when count==0. Emitting a
  // completed event with partial_success=true here would make the console show "completed"
  // AND a partial-success banner implying scenarios exist, when none were saved.
  if (saved === 0 && slots.length > 0) {
    throw new Error("Scenario generation failed for all planned slots.");
  }

  yield {
    type: "metadata",
    metadata: {
      requested_count: input.maxScenarios,
      planned_count: slots.length,
      saved_count: saved,
      failed_count: failedSlotIds.length,
      failed_slot_ids: failedSlotIds,
      deduped_count: deduped,
      // Partial success requires at least one saved scenario (aiassist parity).
      partial_success: saved > 0 && saved < slots.length,
      planner_usage: plannerUsage,
      writer_usages: writerUsages,
      ...(mode === "smoke"
        ? { smoke_cap: smokeCap, smoke_units_hash: smokeUnitsHashOut, dropped_unit_ids: droppedUnitIds }
        : {}),
    },
  };
}
