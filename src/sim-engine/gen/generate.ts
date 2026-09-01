import { LlmError, type LlmProvider, type LlmUsage, type WireReasoningEffort } from "../../llm/index.js";
import { sumUsage } from "../../llm/usage.js";
import { planCapabilities } from "./planner.js";
import { allocateScenarioSlots } from "./allocator.js";
import { allocateSmokeSlots } from "./smoke-allocator.js";
import { AsyncQueue } from "./async-queue.js";
import { plannerCacheKey, plannerCacheGet, plannerCacheSet, plannerCacheDelete } from "./planner-cache.js";
import { writeScenarioChunk } from "./writer.js";
import { WRITER_CHUNK_SIZE, WRITER_CHUNK_RETRIES, WRITER_SLOT_RETRIES, WRITER_FALLBACK_CONCURRENCY, SMOKE_CAP_FALLBACK, MAX_EXISTING_SCENARIO_SUMMARIES } from "./combos.js";
import type { Slot, RuntimeScenario, PlannerWithInventory, ExistingScenarioSummary, SimulationMode } from "./types.js";
import type { FlowInventory } from "./inventory.js";

// AO Simulation Engine — generation orchestration (Phase 1.6).
// Port of the orchestrator service `generate_scenarios_stream`: PLANNER (2 attempts) → deterministic
// ALLOCATOR (2 attempts, replan on the 2nd) → WRITER (chunks of 10, parallel, with
// chunk + per-slot fallback retries) → dedup by coverage_key. Yields progress events
// + scenarios as a discriminated union (the Phase 4 route layer maps these to SSE).
//
// Emission is incremental end-to-end: writer chunks stream in completion order and
// (with SIM_GEN_INCREMENTAL) each scenario surfaces mid-stream as its item completes
// in the LLM token stream. Planner output is cached across identical requests (the
// vibe rerun loop) — see planner-cache.ts.

type Dict = Record<string, any>;

export type GenEvent =
  | { type: "planning_started"; attempt: number; existing_summary_count: number }
  | { type: "planning_done"; attempt: number; capability_count: number; cache_hit?: boolean }
  | { type: "allocation_started"; attempt: number; capability_count: number }
  | { type: "allocation_done"; attempt: number; planned_count: number }
  | { type: "writing_started"; planned_count: number; chunk_count: number; chunk_size: number }
  | { type: "writer_chunk_done"; chunk_index: number; chunk_count: number; chunk_saved_count: number; failed_slot_ids: string[] }
  // scenario_index = the scenario's 0-based SAVED ordinal within its chunk (dedup
  // skips excluded); saved_count is the global running total the console displays.
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
  /** Phase wall-clock durations (ms). planner_ms spans the planner loop (incl. its
   *  retries); allocation_ms spans the allocator loop (incl. a replan's second
   *  planner call); writer_ms spans the writer fan-out through the last emit.
   *  ttfs_ms = time from generation start to the FIRST `scenario` event (null when
   *  nothing was saved) — the perceived-latency number the latency work optimizes. */
  planner_ms: number;
  allocation_ms: number;
  writer_ms: number;
  ttfs_ms: number | null;
  /** True when the plan was served from the planner cache (planner_usage is null
   *  then — no tokens were spent this run). */
  planner_cache_hit: boolean;
  /** True when any writer stream's extractor self-disabled mid-generation, i.e.
   *  incremental emission silently degraded to chunk-granular for part of the run
   *  (output identical — the final parse is authoritative). Direct triage signal
   *  for a ttfs_ms regression; always false when the incremental kill-switch is off. */
  incremental_disabled: boolean;
}

export interface GenerateInput {
  /** Canonical flow (the caller runs parseFlowJson/normalizeFlow first). */
  flowJson: Dict;
  /** The agent-runner mechanical inventory (the route fetches it once, pre-stream, and refuses an
   *  unsimulatable flow before this generator runs). Threaded into every planner call. */
  inventory: FlowInventory;
  phloUuid: string;
  maxScenarios: number;
  model: string;
  /** Per-role reasoning effort for the two generation LLM calls; `undefined` omits the parameter
   *  (the "inherit" default, i.e. the deployment's own default). Passed in rather than read from
   *  env because this pipeline is config-free by design — the route wires
   *  SIM_EVAL_PLANNER_REASONING_EFFORT / SIM_EVAL_WRITER_REASONING_EFFORT, exactly like `model`. */
  plannerReasoningEffort?: WireReasoningEffort;
  writerReasoningEffort?: WireReasoningEffort;
  simulationMode?: SimulationMode;
  testCaseGenerationInstructions?: string;
  existingSummaries?: ExistingScenarioSummary[];
  /** Callers must pre-clamp to SMOKE_CAP_HARD — only the HTTP route does (the gen
   *  pipeline is config-free by design, so the env-tunable hard cap can't live here;
   *  the Python reference clamps inside the generator instead). */
  smokeCap?: number;
  /** Emit each scenario mid-stream as its item completes in the writer's token
   *  stream (default true). False = chunk-granular emission (the pre-incremental
   *  behavior); the route wires this from SIM_GEN_INCREMENTAL as the kill-switch. */
  incrementalEmit?: boolean;
  /** Planner-cache TTL in ms (0/absent = cache disabled — the default for direct
   *  callers and tests). The route wires SIM_GEN_PLANNER_CACHE_TTL_MS. A hit reuses
   *  the plan of a byte-identical prior request (see planner-cache.ts). */
  plannerCacheTtlMs?: number;
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

/** Map with at most `limit` items in flight. A worker's throw rejects the whole
 *  call (matching Promise.all) — used only for abort, which must escape. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One chunk through the writer with chunk-level + per-slot fallback retries.
 *
 *  NEVER rejects except on caller abort: a hard LLM failure (completeJSON throw
 *  after its own retries) degrades to "that attempt produced nothing" and the
 *  retry budget continues; unsatisfied slots come back in `failedSlotIds`. This
 *  is load-bearing for the ledger — a slot already DELIVERED (returned earlier,
 *  or emitted incrementally) must never be marked failed, and only this scope
 *  knows which those are.
 *
 *  `onScenario` (incremental emission) makes delivered slots count as satisfied:
 *  they are excluded from every retry (no token waste, no second version) and
 *  from the returned `scenarios` (the caller already emitted them). Consumption
 *  is recorded AT EMISSION TIME via a wrapper — not from the call's result — so
 *  an attempt that emits scenarios and THEN throws mid-stream still can't get
 *  those slots re-requested or marked failed. */
async function runChunkWithRetry(
  base: { flowJson: Dict; planner: PlannerWithInventory; model: string; reasoningEffort?: WireReasoningEffort; generationId: string; phloUuid: string; chunkIndex: number; instructions?: string; provider?: LlmProvider; signal?: AbortSignal },
  slots: Slot[],
  onScenario?: (s: RuntimeScenario) => void,
): Promise<{ scenarios: RuntimeScenario[]; failedSlotIds: string[]; usages: LlmUsage[]; incrementalDisabled: boolean }> {
  const scenarios: RuntimeScenario[] = [];
  const usages: LlmUsage[] = [];
  let incrementalDisabled = false;
  const consumed = new Set<string>(); // slots delivered incrementally, recorded at emission time
  const record = onScenario
    ? (s: RuntimeScenario): void => {
        const id = s.eval_metadata?.slot_id;
        if (id) consumed.add(id);
        onScenario(s);
      }
    : undefined;
  const logAttemptFailure = (what: string, attempt: number, err: unknown): void => {
    console.error(
      `[sim-gen] writer ${what} attempt ${attempt} failed (generation ${base.generationId}, chunk ${base.chunkIndex}): ${(err as Error).message}`,
    );
  };
  let remaining = slots;

  for (let attempt = 1; attempt <= WRITER_CHUNK_RETRIES + 1 && remaining.length > 0; attempt++) {
    remaining = remaining.filter((s) => !consumed.has(s.slot_id));
    if (remaining.length === 0) break;
    try {
      const res = await writeScenarioChunk({ ...base, slots: remaining, attempt, onScenario: record });
      scenarios.push(...res.scenarios);
      usages.push(res.usage);
      incrementalDisabled ||= res.incrementalDisabled;
      const got = new Set(res.scenarios.map((s) => s.eval_metadata?.slot_id));
      remaining = remaining.filter((s) => !got.has(s.slot_id));
    } catch (err) {
      if (base.signal?.aborted) throw err; // abort is the ONLY rejection that escapes
      // A rejected chunk attempt was still billed for every provider call it made. Dropping
      // it here would leave the writer half of the roll-up quietly understated while the
      // planner half is honest — the worst outcome, since nothing in the output would say
      // which number to trust.
      if (err instanceof LlmError && err.usage) usages.push(err.usage);
      logAttemptFailure("chunk", attempt, err);
    }
  }

  // Per-slot fallback: retry each still-missing slot on its own. Slots are
  // independent single-slot LLM calls, so they run in parallel — but BOUNDED
  // (WRITER_FALLBACK_CONCURRENCY per chunk): this path fires exactly when the
  // provider is degraded, and an unbounded fan-out would land every missing
  // slot's call on the struggling endpoint at once (retry amplification). Each
  // slot's attempts stay serial (same attempt budget as before), and one slot's
  // hard failure burns only its own budget — siblings are unaffected.
  const stillFailed: string[] = [];
  const fallbackResults = await mapPool(
    remaining.filter((slot) => !consumed.has(slot.slot_id)),
    WRITER_FALLBACK_CONCURRENCY,
    async (slot) => {
      for (let attempt = 1; attempt <= WRITER_SLOT_RETRIES + 1; attempt++) {
        // Re-check per attempt: the previous attempt may have emitted the slot
        // mid-stream and THEN thrown — re-requesting it would re-emit a duplicate.
        if (consumed.has(slot.slot_id)) return { slot, scenarios: [] as RuntimeScenario[] };
        try {
          const res = await writeScenarioChunk({ ...base, slots: [slot], attempt, onScenario: record });
          usages.push(res.usage);
          incrementalDisabled ||= res.incrementalDisabled;
          if (res.scenarios.length > 0 || consumed.has(slot.slot_id)) return { slot, scenarios: res.scenarios };
        } catch (err) {
          if (base.signal?.aborted) throw err;
          if (err instanceof LlmError && err.usage) usages.push(err.usage);
          logAttemptFailure(`slot ${slot.slot_id}`, attempt, err);
        }
      }
      return { slot, scenarios: null };
    },
  );
  for (const r of fallbackResults) {
    if (r.scenarios) scenarios.push(...r.scenarios);
    else if (!consumed.has(r.slot.slot_id)) stillFailed.push(r.slot.slot_id);
  }
  return { scenarios, failedSlotIds: stillFailed, usages, incrementalDisabled };
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
  const genStart = Date.now();
  let ttfsMs: number | null = null; // stamped at the first `scenario` yield

  // ── PLANNER (2 attempts; cached across byte-identical requests) ────────────────
  const plannerStart = Date.now();
  const cacheTtlMs = input.plannerCacheTtlMs ?? 0;
  const cacheKey =
    cacheTtlMs > 0
      ? plannerCacheKey({
          flowJson: input.flowJson,
          phloUuid: input.phloUuid,
          model: input.model,
          reasoningEffort: input.plannerReasoningEffort,
          simulationMode: mode,
          smokeCap,
          instructions: input.testCaseGenerationInstructions ?? "",
          // Hash exactly what the planner consumes (planner.ts caps the summaries it
          // sends at MAX_EXISTING_SCENARIO_SUMMARIES) — hashing the full list would
          // churn the key on data the plan can't depend on (spurious misses >cap).
          existingSummaries: existing.slice(0, MAX_EXISTING_SCENARIO_SUMMARIES),
        })
      : null;
  let planner: PlannerWithInventory | null = null;
  // EVERY planner call this generation paid for, including ones that threw. Both the
  // timing roll-up and the `planner_usage` metadata derive from this — there is no second
  // scalar to keep in step, because the two inevitably diverge exactly when the planner is
  // retried, and that is the case where reporting only the survivor understates the run
  // (2026-08-05 smoke: 20,470 tokens burned by a rejected call, against a reported 23,974).
  //
  // Stays EMPTY on a planner-cache hit — no call, no tokens — which is what
  // `planner_cache_hit`'s documented invariant requires of a null `planner_usage`.
  const plannerUsages: LlmUsage[] = [];
  let plannerCacheHit = false;
  if (cacheKey) {
    const cached = plannerCacheGet(cacheKey, cacheTtlMs);
    if (cached) {
      planner = cached;
      plannerCacheHit = true;
      yield { type: "planning_started", attempt: 1, existing_summary_count: existing.length };
      yield { type: "planning_done", attempt: 1, capability_count: planner.capabilities.length, cache_hit: true };
    }
  }
  for (let attempt = 1; attempt <= PLANNER_RETRIES && !planner; attempt++) {
    input.signal?.throwIfAborted();
    yield { type: "planning_started", attempt, existing_summary_count: existing.length };
    try {
      const out = await planCapabilities({
        flowJson: input.flowJson,
        inventory: input.inventory,
        phloUuid: input.phloUuid,
        model: input.model,
        reasoningEffort: input.plannerReasoningEffort,
        existingSummaries: existing,
        userInstructions: instructions,
        simulationMode: mode,
        smokeCap,
        generationId,
        provider: input.plannerProvider,
        signal: input.signal,
      });
      planner = out.planner;
      plannerUsages.push(out.usage);
      yield { type: "planning_done", attempt, capability_count: planner.capabilities.length };
      break;
    } catch (e) {
      // A rejected planner call was still billed for every attempt it made; completeJSON
      // hands those tokens back on the error so the replan does not erase them.
      if (e instanceof LlmError && e.usage) plannerUsages.push(e.usage);
      if (attempt >= PLANNER_RETRIES) throw new Error(`Planner failed after ${PLANNER_RETRIES} attempts: ${(e as Error).message}`);
    }
  }
  if (!planner) throw new Error("Planner produced no output");
  const plannerMs = Date.now() - plannerStart;

  // ── ALLOCATOR (2 attempts; replan on the 2nd) ──────────────────────────────────
  const allocationStart = Date.now();
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
      // The plan under this key failed allocation — poison-pill it (the replanned
      // successor is re-stored below once it passes).
      if (cacheKey) plannerCacheDelete(cacheKey);
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
        inventory: input.inventory,
        phloUuid: input.phloUuid,
        model: input.model,
        reasoningEffort: input.plannerReasoningEffort,
        existingSummaries: existing,
        userInstructions: instructions,
        simulationMode: mode,
        smokeCap,
        generationId,
        provider: input.plannerProvider,
        signal: input.signal,
      });
      planner = out.planner;
      // The replan is a REAL planner call: the metadata must not keep claiming a
      // cache hit (planner_cache_hit + planner_usage:null would report zero planning
      // cost on a generation that paid it in full — corrupting the timing evidence).
      plannerUsages.push(out.usage);
      plannerCacheHit = false;
    }
  }
  if (!slots) throw new Error("Allocator produced no slots");
  // Cache only allocation-proven plans (keyed by the ORIGINAL request inputs, so a
  // replanned successor replaces its poisoned predecessor under the same key).
  if (cacheKey) plannerCacheSet(cacheKey, planner);
  const allocationMs = Date.now() - allocationStart;

  // ── WRITER (parallel chunks + retries) ─────────────────────────────────────────
  const writerStart = Date.now();
  input.signal?.throwIfAborted();
  const chunks = chunk(slots, WRITER_CHUNK_SIZE);
  yield { type: "writing_started", planned_count: slots.length, chunk_count: chunks.length, chunk_size: WRITER_CHUNK_SIZE };

  // Chunks report through a single queue in COMPLETION order — the client sees each
  // chunk's scenarios the moment they exist (mid-stream when incremental, at chunk
  // settle otherwise) instead of waiting for the slowest chunk (the previous
  // Promise.all gated ALL emission on the last chunk + its retries). ALL scenarios —
  // incremental and final-parse alike — ride the queue as `scenario` events, so the
  // consumer has exactly one emit path; `chunk_done` is purely terminal bookkeeping.
  // runChunkWithRetry never rejects except on caller abort (hard LLM failures degrade
  // to failed slots inside it), so every chunk promise pushes exactly one terminal
  // event and nothing rejects unhandled.
  type WriterQueueEvent =
    | { kind: "scenario"; chunkIndex: number; scenario: RuntimeScenario }
    | { kind: "chunk_done"; chunkIndex: number; failedSlotIds: string[]; usages: LlmUsage[]; incrementalDisabled: boolean }
    | { kind: "abort"; err: unknown };
  const queue = new AsyncQueue<WriterQueueEvent>();
  // Incremental emission (kill-switch: SIM_GEN_INCREMENTAL / GenerateInput.incrementalEmit,
  // default ON — it's an output-timing improvement with identical output, unlike the
  // planner cache which holds cross-request state and is opt-in): each scenario surfaces
  // the moment its item completes in the LLM token stream. With the switch off (or a
  // provider without text deltas) nothing streams mid-chunk and behavior is
  // chunk-granular, exactly as before.
  const incremental = input.incrementalEmit ?? true;
  // Per-chunk wall clock. Chunks are launched in this loop and run CONCURRENTLY, so
  // their durations overlap and deliberately do NOT sum to writer_ms — each is the
  // latency of one chunk's own LLM call(s), which is what identifies the straggler
  // that set the generation's end time.
  const chunkStartedAt = new Map<number, number>();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    chunkStartedAt.set(i, Date.now());
    runChunkWithRetry(
      { flowJson: input.flowJson, planner: planner!, model: input.model, reasoningEffort: input.writerReasoningEffort, generationId, phloUuid: input.phloUuid, chunkIndex: i, instructions, provider: input.writerProvider, signal: input.signal },
      c,
      incremental ? (scenario) => queue.push({ kind: "scenario", chunkIndex: i, scenario }) : undefined,
    ).then(
      (result) => {
        for (const scenario of result.scenarios) queue.push({ kind: "scenario", chunkIndex: i, scenario });
        queue.push({ kind: "chunk_done", chunkIndex: i, failedSlotIds: result.failedSlotIds, usages: result.usages, incrementalDisabled: result.incrementalDisabled });
      },
      (err) => {
        if (input.signal?.aborted) {
          queue.push({ kind: "abort", err });
          return;
        }
        // Unreachable by design (runChunkWithRetry only rethrows aborts) — kept so an
        // unexpected bug degrades to a failed chunk instead of hanging the consumer.
        console.error(`[sim-gen] writer chunk ${i} rejected unexpectedly (generation ${generationId}): ${(err as Error).message}`);
        queue.push({ kind: "chunk_done", chunkIndex: i, failedSlotIds: c.map((s) => s.slot_id), usages: [], incrementalDisabled: false });
      },
    );
  }

  // Emit scenarios as they arrive (mid-stream when incremental, at chunk settle
  // otherwise); dedup by smoke_unit_id (smoke) / coverage_key (stress). `admit` is
  // the single ledger owner — every delivered scenario passes through it exactly
  // once, keeping the invariant planned = saved + failed + deduped.
  const writerUsages: LlmUsage[] = [];
  const failedSlotIds: string[] = [];
  let incrementalDisabled = false;
  const seenCoverage = new Set<string>();
  const perChunkSaved = new Map<number, number>();
  let saved = 0;
  let deduped = 0;
  // Anchors the per-scenario `delta_ms`. Starts at genStart so the first scenario's
  // delta equals its at_ms (= ttfs_ms) rather than reading as an instant arrival.
  let lastScenarioAt = genStart;
  const admit = (scenario: RuntimeScenario, chunkIndex: number): boolean => {
    // Smoke units under one capability legitimately share all 8 coverage axes (same
    // kind + route ⇒ identical coverage_key), so dedup smoke by the audit-unique
    // smoke_unit_id; stress keeps coverage_key (its allocator guarantees uniqueness).
    const key = scenario.eval_metadata?.smoke_unit_id || scenario.eval_metadata?.coverage_key || "";
    if (key && seenCoverage.has(key)) {
      deduped += 1; // counted so the shortfall is visible in metadata, not silent
      return false;
    }
    if (key) seenCoverage.add(key);
    saved += 1;
    perChunkSaved.set(chunkIndex, (perChunkSaved.get(chunkIndex) ?? 0) + 1);
    ttfsMs ??= Date.now() - genStart;
    return true;
  };
  let remainingChunks = chunks.length;
  while (remainingChunks > 0) {
    const ev = await queue.pop();
    if (ev.kind === "abort") throw ev.err;
    if (ev.kind === "scenario") {
      // Every scenario (mid-stream or final-parse) arrives here — `admit` is the
      // single ledger owner by construction, and each slot flows through it once
      // (the writer excludes incrementally-delivered slots from its final result).
      if (admit(ev.scenario, ev.chunkIndex)) {
        // Per-scenario emission timeline.
        //
        // A scenario has no individually measurable token cost — ONE writer LLM call
        // streams a whole chunk of them — so the honest per-scenario quantity is WHEN
        // it landed: `at_ms` from generation start and `delta_ms` since the previous
        // scenario. Together these give the arrival curve for a 30/40/50-scenario run
        // (which is what the streaming console renders) and make a chunk stalling
        // mid-stream visible as a single large delta instead of a flat average.
        const at = Date.now();
        console.log(
          `[sim-gen] scenario generation=${generationId} index=${saved - 1} ` +
            `slot_id=${ev.scenario.eval_metadata?.slot_id ?? "-"} chunk=${ev.chunkIndex} ` +
            `at_ms=${at - genStart} delta_ms=${at - lastScenarioAt}`,
        );
        lastScenarioAt = at;
        yield { type: "scenario", scenario: ev.scenario };
        yield { type: "writer_scenario_done", chunk_index: ev.chunkIndex, chunk_count: chunks.length, scenario_index: (perChunkSaved.get(ev.chunkIndex) ?? 1) - 1, saved_count: saved, slot_id: ev.scenario.eval_metadata?.slot_id ?? "" };
      }
      continue;
    }
    remainingChunks -= 1;
    writerUsages.push(...ev.usages);
    failedSlotIds.push(...ev.failedSlotIds);
    incrementalDisabled ||= ev.incrementalDisabled;
    // Per-chunk accounting: the finest granularity at which token cost is genuinely
    // ATTRIBUTABLE, because a chunk is one LLM call (or its retries). Cost per
    // scenario is chunk tokens ÷ chunk saved — an amortisation, which is why it is
    // left to the reader rather than printed as if it were measured per scenario.
    const { usage: chunkUsage, calls: chunkCalls } = sumUsage(ev.usages);
    const chunkSaved = perChunkSaved.get(ev.chunkIndex) ?? 0;
    console.log(
      `[sim-gen] chunk generation=${generationId} chunk=${ev.chunkIndex}/${chunks.length} ` +
        `slots=${chunks[ev.chunkIndex]?.length ?? 0} saved=${chunkSaved} failed=${ev.failedSlotIds.length} ` +
        `duration_ms=${Date.now() - (chunkStartedAt.get(ev.chunkIndex) ?? writerStart)} llm_calls=${chunkCalls} ` +
        `prompt_tokens=${chunkUsage.promptTokens} completion_tokens=${chunkUsage.completionTokens} ` +
        `reasoning_tokens=${chunkUsage.reasoningTokens ?? 0} total_tokens=${chunkUsage.totalTokens}`,
    );
    yield { type: "writer_chunk_done", chunk_index: ev.chunkIndex, chunk_count: chunks.length, chunk_saved_count: perChunkSaved.get(ev.chunkIndex) ?? 0, failed_slot_ids: ev.failedSlotIds };
  }

  // All-failed: every planned slot failed and nothing was saved. Throw (the route's
  // catch emits an SSE `error` event) instead of a `completed`/metadata event — mirrors
  // aiassist, which emits `type:"error"` and no `completed` when count==0. Emitting a
  // completed event with partial_success=true here would make the console show "completed"
  // AND a partial-success banner implying scenarios exist, when none were saved.
  if (saved === 0 && slots.length > 0) {
    throw new Error("Scenario generation failed for all planned slots.");
  }

  const writerMs = Date.now() - writerStart;
  // Per-STAGE token roll-up alongside the per-stage timings, so one grep answers
  // "what did these N scenarios cost, where did the tokens go, and how long did each
  // stage take". The per-call `[llm] usage` lines stay the source of truth; this is
  // the headline.
  //
  // The ALLOCATOR is absent here on purpose, not by oversight: it is pure deterministic
  // enumeration with no LLM call (see allocateScenarioSlots), so its token cost is
  // structurally zero and `allocation_ms` is its whole story. Emitting a hardcoded
  // `allocation_tokens=0` would imply it was measured and could one day be non-zero.
  const { usage: plannerU, calls: plannerCalls } = sumUsage(plannerUsages);
  const { usage: writerU, calls: writerCalls } = sumUsage(writerUsages);
  // No cost_usd here, deliberately. Costing needs a PROVIDER name, and this whole
  // module tree (generate/planner/writer/allocator) takes everything through
  // GenerateInput and imports no config — which is what lets the gen tests run
  // without parsing real env. Importing config, or plumbing a provider name through
  // GenerateInput, to print one log field would trade that invariant for nothing:
  // the per-call `[llm] usage` lines already carry both cost_usd AND
  // correlation_id=<generation-id>, so generation cost is a group-by away:
  //   phrase "[llm] usage" AND correlation_id=<id>  ->  sum(cost_usd)
  console.log(
    `[sim-gen] timing generation=${generationId} planner_ms=${plannerMs} allocation_ms=${allocationMs} writer_ms=${writerMs} ttfs_ms=${ttfsMs} saved=${saved}/${slots.length} ` +
      `planner_prompt_tokens=${plannerU.promptTokens} planner_completion_tokens=${plannerU.completionTokens} ` +
      `planner_reasoning_tokens=${plannerU.reasoningTokens ?? 0} planner_llm_calls=${plannerCalls} ` +
      `writer_prompt_tokens=${writerU.promptTokens} writer_completion_tokens=${writerU.completionTokens} ` +
      `writer_reasoning_tokens=${writerU.reasoningTokens ?? 0} writer_llm_calls=${writerCalls} ` +
      `total_tokens=${plannerU.totalTokens + writerU.totalTokens} llm_calls=${plannerCalls + writerCalls}`,
  );
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
      planner_usage: plannerUsages.length ? sumUsage(plannerUsages).usage : null,
      writer_usages: writerUsages,
      ...(mode === "smoke"
        ? { smoke_cap: smokeCap, smoke_units_hash: smokeUnitsHashOut, dropped_unit_ids: droppedUnitIds }
        : {}),
      planner_ms: plannerMs,
      allocation_ms: allocationMs,
      writer_ms: writerMs,
      ttfs_ms: ttfsMs,
      planner_cache_hit: plannerCacheHit,
      incremental_disabled: incrementalDisabled,
    },
  };
}
