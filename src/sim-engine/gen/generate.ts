import type { LlmProvider, LlmUsage } from "../../llm/index.js";
import { planCapabilities } from "./planner.js";
import { allocateScenarioSlots } from "./allocator.js";
import { writeScenarioChunk } from "./writer.js";
import { WRITER_CHUNK_SIZE, WRITER_CHUNK_RETRIES, WRITER_SLOT_RETRIES } from "./combos.js";
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
  partial_success: boolean;
  planner_usage: LlmUsage | null;
  writer_usages: LlmUsage[];
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
  smokeCap?: number;
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
  base: { flowJson: Dict; planner: PlannerWithInventory; model: string; generationId: string; phloUuid: string; chunkIndex: number; provider?: LlmProvider },
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
  if (mode === "smoke") throw new Error("smoke mode allocation is not yet implemented (Phase 1.4 deferred allocateSmokeSlots)");
  const existing = input.existingSummaries ?? [];
  const generationId = crypto.randomUUID();
  let instructions = input.testCaseGenerationInstructions ?? "";

  // ── PLANNER (2 attempts) ──────────────────────────────────────────────────────
  let planner: PlannerWithInventory | null = null;
  let plannerUsage: LlmUsage | null = null;
  for (let attempt = 1; attempt <= PLANNER_RETRIES; attempt++) {
    yield { type: "planning_started", attempt, existing_summary_count: existing.length };
    try {
      const out = await planCapabilities({
        flowJson: input.flowJson,
        phloUuid: input.phloUuid,
        model: input.model,
        existingSummaries: existing,
        userInstructions: instructions,
        simulationMode: mode,
        smokeCap: input.smokeCap,
        provider: input.plannerProvider,
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
  for (let attempt = 1; attempt <= ALLOCATION_RETRIES; attempt++) {
    yield { type: "allocation_started", attempt, capability_count: planner.capabilities.length };
    try {
      const result = allocateScenarioSlots(planner, input.maxScenarios, existing);
      slots = result.slots;
      yield { type: "allocation_done", attempt, planned_count: slots.length };
      break;
    } catch (e) {
      if (attempt >= ALLOCATION_RETRIES) throw new Error(`Allocator failed after ${ALLOCATION_RETRIES} attempts: ${(e as Error).message}`);
      // Replan with the allocator error appended to the instructions.
      instructions = `${instructions}\n\n[allocator retry] ${(e as Error).message}`.trim();
      const out = await planCapabilities({
        flowJson: input.flowJson,
        phloUuid: input.phloUuid,
        model: input.model,
        existingSummaries: existing,
        userInstructions: instructions,
        simulationMode: mode,
        smokeCap: input.smokeCap,
        provider: input.plannerProvider,
      });
      planner = out.planner;
    }
  }
  if (!slots) throw new Error("Allocator produced no slots");

  // ── WRITER (parallel chunks + retries) ─────────────────────────────────────────
  const chunks = chunk(slots, WRITER_CHUNK_SIZE);
  yield { type: "writing_started", planned_count: slots.length, chunk_count: chunks.length, chunk_size: WRITER_CHUNK_SIZE };

  const results = await Promise.all(
    chunks.map((c, i) =>
      runChunkWithRetry(
        { flowJson: input.flowJson, planner: planner!, model: input.model, generationId, phloUuid: input.phloUuid, chunkIndex: i, provider: input.writerProvider },
        c,
      ),
    ),
  );

  // Emit per-chunk + per-scenario events, dedup by coverage_key.
  const writerUsages: LlmUsage[] = [];
  const failedSlotIds: string[] = [];
  const seenCoverage = new Set<string>();
  let saved = 0;
  for (let chunkIndex = 0; chunkIndex < results.length; chunkIndex++) {
    const r = results[chunkIndex];
    writerUsages.push(...r.usages);
    failedSlotIds.push(...r.failedSlotIds);
    let chunkSaved = 0;
    for (let i = 0; i < r.scenarios.length; i++) {
      const scenario = r.scenarios[i];
      const key = scenario.eval_metadata?.coverage_key ?? "";
      if (key && seenCoverage.has(key)) continue; // dedup
      if (key) seenCoverage.add(key);
      saved += 1;
      chunkSaved += 1;
      yield { type: "scenario", scenario };
      yield { type: "writer_scenario_done", chunk_index: chunkIndex, chunk_count: chunks.length, scenario_index: i, saved_count: saved, slot_id: scenario.eval_metadata?.slot_id ?? "" };
    }
    yield { type: "writer_chunk_done", chunk_index: chunkIndex, chunk_count: chunks.length, chunk_saved_count: chunkSaved, failed_slot_ids: r.failedSlotIds };
  }

  yield {
    type: "metadata",
    metadata: {
      requested_count: input.maxScenarios,
      planned_count: slots.length,
      saved_count: saved,
      failed_count: failedSlotIds.length,
      failed_slot_ids: failedSlotIds,
      partial_success: saved < slots.length,
      planner_usage: plannerUsage,
      writer_usages: writerUsages,
    },
  };
}
