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
  /** saved < the user's ask (requested count for stress, planned units for smoke),
   *  with at least one scenario saved (aiassist parity). Internal over-planning
   *  (top-up) never flags a fully-delivered request as partial. */
  partial_success: boolean;
  /** The accepted stress allocation stopped short of the request even after pool
   *  expansion AND a replan — planned_count < requested is the flow's (well, the
   *  final plan's) real capacity, not a failure. Always false for smoke. */
  capacity_limited: boolean;
  /** Exact-count top-up wave (stress only): fresh slots planned for the shortfall
   *  and how many of them saved. Always emitted — 0/0 when the first wave met the
   *  request (and always in smoke, which has no top-up). */
  topup_planned: number;
  topup_saved: number;
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
  /** ONE bounded top-up wave when the first wave saves fewer than requested
   *  (stress mode only; route wires SIM_GEN_TOPUP, default true). */
  exactCountTopUp?: boolean;
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
  base: {
    flowJson: Dict;
    planner: PlannerWithInventory;
    model: string;
    /** Writer reasoning effort; `undefined` omits the parameter (the "inherit" default). */
    reasoningEffort?: WireReasoningEffort;
    generationId: string;
    phloUuid: string;
    chunkIndex: number;
    provider?: LlmProvider;
    signal?: AbortSignal;
    /** Solo-fallback policy for slots omitted by every CLEAN chunk attempt
     *  (model-declined). "skip-declines" is the stress-mode retry economy — the
     *  top-up wave compensates for skipped slots there. Smoke uses "full": it has
     *  no top-up, so a silently-shortened suite would have no rescue. */
    fallbackPolicy?: "full" | "skip-declines";
  },
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
  // Clean (non-throwing) chunk attempts that OMITTED a slot: the model answered
  // healthily and still declined to write it. Distinct from transport/parse
  // failures — those don't increment this and keep the full fallback budget.
  const cleanOmissions = new Map<string, number>();

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
      // A slot the model WROTE but validation rejected is not a decline — the model
      // engaged with it, and the focused solo retry historically rescues exactly
      // this class. Only a slot absent from BOTH scenarios and validationErrors
      // was genuinely passed over.
      const rejected = new Set(res.validationErrors.map((v) => v.slot_id));
      for (const s of remaining) {
        if (!consumed.has(s.slot_id) && !rejected.has(s.slot_id)) cleanOmissions.set(s.slot_id, (cleanOmissions.get(s.slot_id) ?? 0) + 1);
      }
    } catch (err) {
      if (base.signal?.aborted) throw err; // abort is the ONLY rejection that escapes
      logAttemptFailure("chunk", attempt, err);
    }
  }

  // Retry economy: a slot omitted by EVERY chunk attempt while each attempt
  // returned cleanly is model-declined — the model has repeatedly judged it
  // indistinguishable from its siblings (dominant on low-capability flows:
  // 2026-07-14 prod, 18/40 slots burned the full solo ladder for zero yield,
  // ~half the writer wall-clock). Solo-retrying it re-asks the same question;
  // skip the fallback and mark it failed now. Slots missing because an attempt
  // THREW keep the full fallback — that's the transport-failure rescue path.
  const chunkAttemptBudget = WRITER_CHUNK_RETRIES + 1;
  const pending = remaining.filter((slot) => !consumed.has(slot.slot_id));
  const declinedSlots = base.fallbackPolicy === "skip-declines"
    ? pending.filter((slot) => (cleanOmissions.get(slot.slot_id) ?? 0) >= chunkAttemptBudget)
    : [];
  const declinedIds = new Set(declinedSlots.map((s) => s.slot_id));
  // Accumulates BOTH failure kinds: policy-skipped declines (seeded here) and
  // fallback-exhausted slots (pushed after the fallback below).
  const unsatisfiedSlotIds: string[] = [...declinedIds];
  if (declinedSlots.length > 0) {
    console.log(
      `[sim-gen] writer chunk ${base.chunkIndex}: ${declinedSlots.length} slot(s) declined by ${chunkAttemptBudget} clean attempts — skipping solo fallback (${unsatisfiedSlotIds.join(",")})`,
    );
  }

  // Per-slot fallback: retry each still-missing slot on its own. Slots are
  // independent single-slot LLM calls, so they run in parallel — but BOUNDED
  // (WRITER_FALLBACK_CONCURRENCY per chunk): this path fires exactly when the
  // provider is degraded, and an unbounded fan-out would land every missing
  // slot's call on the struggling endpoint at once (retry amplification). Each
  // slot's attempts stay serial (same attempt budget as before), and one slot's
  // hard failure burns only its own budget — siblings are unaffected.
  const fallbackResults = await mapPool(
    pending.filter((slot) => !declinedIds.has(slot.slot_id)),
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
          logAttemptFailure(`slot ${slot.slot_id}`, attempt, err);
        }
      }
      return { slot, scenarios: null };
    },
  );
  for (const r of fallbackResults) {
    if (r.scenarios) scenarios.push(...r.scenarios);
    else if (!consumed.has(r.slot.slot_id)) unsatisfiedSlotIds.push(r.slot.slot_id);
  }
  return { scenarios, failedSlotIds: unsatisfiedSlotIds, usages, incrementalDisabled };
}

/** What the allocation phase hands back to the pipeline — consumed exactly once. */
interface AllocationOutcome {
  slots: Slot[];
  /** Stress only: the ACCEPTED allocation stopped short of the request even after
   *  pool expansion and a replan. Always false for smoke. */
  capacityLimited: boolean;
  /** Smoke-mode metadata extras (aiassist parity) — absent for stress. */
  smokeUnitsHash?: string;
  droppedUnitIds?: string[];
  /** The plan the slots were allocated FROM (a replan replaces the original), with
   *  its accounting: a replan is a REAL planner call, so usage is captured and any
   *  cache-hit claim is dropped (metadata must not report zero planning cost). */
  planner: PlannerWithInventory;
  plannerUsage: LlmUsage | null;
  /** EVERY planner call this allocation made, including rejected ones — `plannerUsage`
   *  is only the survivor (the planner_usage metadata contract). */
  plannerUsages: LlmUsage[];
  plannerCacheHit: boolean;
}

/** ALLOCATOR phase: up to ALLOCATION_RETRIES attempts, replanning with the failure
 *  appended as an instruction hint between attempts (poison-pilling the planner
 *  cache each time). Failures travel on an explicit `failure` channel: a
 *  capacity-limited allocation on a non-final attempt is a RETRYABLE outcome (the
 *  limit is a property of the plan — a thin planner output is its known failure
 *  mode — and a replan can manufacture capacity a bigger enumeration budget
 *  cannot), while allocator throws (audit-invalid, no candidates) funnel into the
 *  same channel via catch. Only the final attempt accepts a short result. */
async function* allocateWithReplan(args: {
  mode: SimulationMode;
  smokeCap: number;
  maxScenarios: number;
  existing: ExistingScenarioSummary[];
  instructions: string;
  cacheKey: string | null;
  planner: PlannerWithInventory;
  plannerUsage: LlmUsage | null;
  plannerCacheHit: boolean;
  plan: { flowJson: Dict; phloUuid: string; model: string; reasoningEffort?: WireReasoningEffort; generationId?: string; provider?: LlmProvider; signal?: AbortSignal };
}): AsyncGenerator<GenEvent, AllocationOutcome> {
  let { planner, plannerUsage, plannerCacheHit, instructions } = args;
  const plannerUsages: LlmUsage[] = [];
  let slots: Slot[] | null = null;
  let capacityLimited = false;
  let smokeUnitsHash: string | undefined;
  let droppedUnitIds: string[] | undefined;
  for (let attempt = 1; attempt <= ALLOCATION_RETRIES; attempt++) {
    yield { type: "allocation_started", attempt, capability_count: planner.capabilities.length };
    let failure: string | null = null;
    try {
      if (args.mode === "smoke") {
        const result = allocateSmokeSlots({ planner, smokeCap: args.smokeCap });
        slots = result.slots;
        smokeUnitsHash = result.smoke_units_hash;
        droppedUnitIds = result.dropped_unit_ids;
      } else {
        const result = allocateScenarioSlots(planner, args.maxScenarios, args.existing);
        if (result.audit.capacity_limited && attempt < ALLOCATION_RETRIES) {
          failure = `Allocator capacity-limited: the plan yields only ${result.slots.length} distinct scenario slots of ${args.maxScenarios} requested. Emit more (finer-grained) distinct capabilities so allocation can reach the requested count.`;
        } else {
          slots = result.slots;
          capacityLimited = result.audit.capacity_limited;
        }
      }
    } catch (e) {
      failure = (e as Error).message;
    }
    if (!failure) {
      yield { type: "allocation_done", attempt, planned_count: slots!.length };
      break;
    }
    // The plan under this key failed allocation — poison-pill it (the replanned
    // successor is re-stored by the caller once it passes).
    if (args.cacheKey) plannerCacheDelete(args.cacheKey);
    if (attempt >= ALLOCATION_RETRIES) throw new Error(`Allocator failed after ${ALLOCATION_RETRIES} attempts: ${failure}`);
    // Replan with the failure appended to the instructions. In smoke mode the
    // dominant failure is a planner that omitted smoke_units — say so explicitly
    // (aiassist parity).
    const retryHint =
      args.mode === "smoke"
        ? `[allocator retry] ${failure}. You MUST emit smoke_units under each capability.`
        : `[allocator retry] ${failure}`;
    instructions = `${instructions}\n\n${retryHint}`.trim();
    const out = await planCapabilities({
      flowJson: args.plan.flowJson,
      phloUuid: args.plan.phloUuid,
      model: args.plan.model,
      reasoningEffort: args.plan.reasoningEffort,
      existingSummaries: args.existing,
      userInstructions: instructions,
      simulationMode: args.mode,
      smokeCap: args.smokeCap,
      generationId: args.plan.generationId,
      provider: args.plan.provider,
      signal: args.plan.signal,
    });
    planner = out.planner;
    plannerUsage = out.usage;
    plannerUsages.push(out.usage);
    plannerCacheHit = false;
  }
  if (!slots) throw new Error("Allocator produced no slots");
  return { slots, capacityLimited, smokeUnitsHash, droppedUnitIds, planner, plannerUsage, plannerUsages, plannerCacheHit };
}

/** Everything a writer wave needs that is fixed for the whole generation. */
interface WriterContext {
  flowJson: Dict;
  planner: PlannerWithInventory;
  model: string;
  /** Writer reasoning effort; `undefined` omits the parameter (the "inherit" default). */
  reasoningEffort?: WireReasoningEffort;
  generationId: string;
  phloUuid: string;
  provider?: LlmProvider;
  signal?: AbortSignal;
  fallbackPolicy: "full" | "skip-declines";
  /** Emit each scenario mid-stream as its item completes in the LLM token stream
   *  (SIM_GEN_INCREMENTAL kill-switch, default ON). Off = chunk-granular emission. */
  incremental: boolean;
  /** Generation start — anchors ttfsMs at the first admitted scenario. */
  genStart: number;
}

// Chunks report through a single queue in COMPLETION order — the client sees each
// chunk's scenarios the moment they exist (mid-stream when incremental, at chunk
// settle otherwise) instead of waiting for the slowest chunk. ALL scenarios —
// incremental and final-parse alike — ride the queue as `scenario` events, so the
// consumer has exactly one emit path; `chunk_done` is purely terminal bookkeeping.
// runChunkWithRetry never rejects except on caller abort (hard LLM failures degrade
// to failed slots inside it), so every chunk promise pushes exactly one terminal
// event and nothing rejects unhandled.
type WriterQueueEvent =
  | { kind: "scenario"; chunkIndex: number; scenario: RuntimeScenario }
  | { kind: "chunk_done"; chunkIndex: number; failedSlotIds: string[]; usages: LlmUsage[]; incrementalDisabled: boolean }
  | { kind: "abort"; err: unknown };

/** The writer phase's single source of truth across waves. `admit` is the one
 *  ledger gate — every delivered scenario passes through it exactly once, keeping
 *  the invariant planned_total = saved + failed + deduped across the first wave
 *  AND the exact-count top-up. Both `writing_started` announcements route through
 *  `announceWriting`, so chunk events can never exceed the announced chunk_count. */
class WriterLedger {
  saved = 0;
  deduped = 0;
  /** Cumulative chunk count across waves — stamped at each wave start. */
  totalChunks = 0;
  /** Time from generation start to the FIRST admitted scenario (null = none saved). */
  ttfsMs: number | null = null;
  incrementalDisabled = false;
  readonly failedSlotIds: string[] = [];
  readonly usages: LlmUsage[] = [];
  private readonly seenCoverage = new Set<string>();
  private readonly perChunkSaved = new Map<number, number>();
  /** Anchors the per-scenario `delta_ms`. Starts at genStart so the first scenario's
   *  delta equals its at_ms (= ttfsMs) rather than reading as an instant arrival. */
  private lastScenarioAt: number;
  /** Per-chunk wall clock, stamped at launch. Chunks run CONCURRENTLY, so these
   *  durations overlap and deliberately do NOT sum to writer_ms — each is one chunk's
   *  own latency, which is what identifies the straggler that set the end time. */
  private readonly chunkStartedAt = new Map<number, number>();

  constructor(private readonly ctx: WriterContext) {
    this.lastScenarioAt = ctx.genStart;
  }

  announceWriting(newSlotCount: number, cumulativePlannedCount: number): GenEvent {
    return {
      type: "writing_started",
      planned_count: cumulativePlannedCount,
      chunk_count: this.totalChunks + Math.ceil(newSlotCount / WRITER_CHUNK_SIZE),
      chunk_size: WRITER_CHUNK_SIZE,
    };
  }

  private admit(scenario: RuntimeScenario, chunkIndex: number): boolean {
    // Smoke units under one capability legitimately share all 8 coverage axes (same
    // kind + route ⇒ identical coverage_key), so dedup smoke by the audit-unique
    // smoke_unit_id; stress keeps coverage_key (its allocator guarantees uniqueness).
    const key = scenario.eval_metadata?.smoke_unit_id || scenario.eval_metadata?.coverage_key || "";
    if (key && this.seenCoverage.has(key)) {
      this.deduped += 1; // counted so the shortfall is visible in metadata, not silent
      return false;
    }
    if (key) this.seenCoverage.add(key);
    this.saved += 1;
    this.perChunkSaved.set(chunkIndex, (this.perChunkSaved.get(chunkIndex) ?? 0) + 1);
    this.ttfsMs ??= Date.now() - this.ctx.genStart;
    return true;
  }

  /** One writer wave: fire every chunk concurrently, drain the queue, update the
   *  ledger. Used once for the planned slots and (optionally) once more for the
   *  exact-count top-up — identical machinery, different slots. */
  async *runWave(waveSlots: Slot[], chunkBase: number): AsyncGenerator<GenEvent> {
    const waveChunks = chunk(waveSlots, WRITER_CHUNK_SIZE);
    this.totalChunks = chunkBase + waveChunks.length;
    const queue = new AsyncQueue<WriterQueueEvent>();
    for (let i = 0; i < waveChunks.length; i++) {
      const abs = chunkBase + i;
      const c = waveChunks[i];
      this.chunkStartedAt.set(abs, Date.now());
      runChunkWithRetry(
        { flowJson: this.ctx.flowJson, planner: this.ctx.planner, model: this.ctx.model, reasoningEffort: this.ctx.reasoningEffort, generationId: this.ctx.generationId, phloUuid: this.ctx.phloUuid, chunkIndex: abs, provider: this.ctx.provider, signal: this.ctx.signal, fallbackPolicy: this.ctx.fallbackPolicy },
        c,
        this.ctx.incremental ? (scenario) => queue.push({ kind: "scenario", chunkIndex: abs, scenario }) : undefined,
      ).then(
        (result) => {
          for (const scenario of result.scenarios) queue.push({ kind: "scenario", chunkIndex: abs, scenario });
          queue.push({ kind: "chunk_done", chunkIndex: abs, failedSlotIds: result.failedSlotIds, usages: result.usages, incrementalDisabled: result.incrementalDisabled });
        },
        (err) => {
          if (this.ctx.signal?.aborted) {
            queue.push({ kind: "abort", err });
            return;
          }
          // Unreachable by design (runChunkWithRetry only rethrows aborts) — kept so an
          // unexpected bug degrades to a failed chunk instead of hanging the consumer.
          console.error(`[sim-gen] writer chunk ${abs} rejected unexpectedly (generation ${this.ctx.generationId}): ${(err as Error).message}`);
          queue.push({ kind: "chunk_done", chunkIndex: abs, failedSlotIds: c.map((s) => s.slot_id), usages: [], incrementalDisabled: false });
        },
      );
    }
    let remainingChunks = waveChunks.length;
    while (remainingChunks > 0) {
      const ev = await queue.pop();
      if (ev.kind === "abort") throw ev.err;
      if (ev.kind === "scenario") {
        // Every scenario (mid-stream or final-parse) arrives here — `admit` is the
        // single ledger gate by construction, and each slot flows through it once
        // (the writer excludes incrementally-delivered slots from its final result).
        if (this.admit(ev.scenario, ev.chunkIndex)) {
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
            `[sim-gen] scenario generation=${this.ctx.generationId} index=${this.saved - 1} ` +
              `slot_id=${ev.scenario.eval_metadata?.slot_id ?? "-"} chunk=${ev.chunkIndex} ` +
              `at_ms=${at - this.ctx.genStart} delta_ms=${at - this.lastScenarioAt}`,
          );
          this.lastScenarioAt = at;
          yield { type: "scenario", scenario: ev.scenario };
          yield { type: "writer_scenario_done", chunk_index: ev.chunkIndex, chunk_count: this.totalChunks, scenario_index: (this.perChunkSaved.get(ev.chunkIndex) ?? 1) - 1, saved_count: this.saved, slot_id: ev.scenario.eval_metadata?.slot_id ?? "" };
        }
        continue;
      }
      remainingChunks -= 1;
      this.usages.push(...ev.usages);
      this.failedSlotIds.push(...ev.failedSlotIds);
      this.incrementalDisabled ||= ev.incrementalDisabled;
      // Per-chunk accounting: the finest granularity at which token cost is genuinely
      // ATTRIBUTABLE, because a chunk is one LLM call (or its retries). Cost per
      // scenario is chunk tokens / chunk saved — an amortisation, which is why it is
      // left to the reader rather than printed as if it were measured per scenario.
      const { usage: chunkUsage, calls: chunkCalls } = sumUsage(ev.usages);
      console.log(
        `[sim-gen] chunk generation=${this.ctx.generationId} chunk=${ev.chunkIndex}/${this.totalChunks} ` +
          `slots=${waveChunks[ev.chunkIndex - chunkBase]?.length ?? 0} ` +
          `saved=${this.perChunkSaved.get(ev.chunkIndex) ?? 0} failed=${ev.failedSlotIds.length} ` +
          `duration_ms=${Date.now() - (this.chunkStartedAt.get(ev.chunkIndex) ?? this.ctx.genStart)} ` +
          `llm_calls=${chunkCalls} prompt_tokens=${chunkUsage.promptTokens} ` +
          `completion_tokens=${chunkUsage.completionTokens} reasoning_tokens=${chunkUsage.reasoningTokens ?? 0} ` +
          `total_tokens=${chunkUsage.totalTokens}`,
      );
      yield { type: "writer_chunk_done", chunk_index: ev.chunkIndex, chunk_count: this.totalChunks, chunk_saved_count: this.perChunkSaved.get(ev.chunkIndex) ?? 0, failed_slot_ids: ev.failedSlotIds };
    }
  }
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
  let plannerUsage: LlmUsage | null = null;
  // EVERY planner call this generation paid for, including ones that threw. `plannerUsage`
  // stays the LAST SUCCESSFUL call because it is the `planner_usage` metadata contract;
  // this accumulator is what the timing roll-up bills against. They diverge exactly when
  // the planner is retried — the case where reporting only the survivor understates the
  // run (2026-08-05 smoke: 20,470 tokens burned by a rejected call, invisible in a
  // roll-up that showed 23,974).
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
      plannerUsage = out.usage;
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
  const alloc = yield* allocateWithReplan({
    mode,
    smokeCap,
    maxScenarios: input.maxScenarios,
    existing,
    instructions,
    cacheKey,
    planner,
    plannerUsage,
    plannerCacheHit,
    plan: { flowJson: input.flowJson, phloUuid: input.phloUuid, model: input.model, reasoningEffort: input.plannerReasoningEffort, generationId, provider: input.plannerProvider, signal: input.signal },
  });
  const { slots, capacityLimited } = alloc;
  planner = alloc.planner;
  plannerUsage = alloc.plannerUsage;
  plannerUsages.push(...alloc.plannerUsages);
  plannerCacheHit = alloc.plannerCacheHit;

  // Cache only allocation-proven plans (keyed by the ORIGINAL request inputs, so a
  // replanned successor replaces its poisoned predecessor under the same key). A
  // capacity-limited plan is NOT proven — caching it would serve the thin plan to
  // every identical rerun inside the TTL, pinning the shortfall.
  if (cacheKey && !capacityLimited) plannerCacheSet(cacheKey, planner);
  const allocationMs = Date.now() - allocationStart;

  // ── WRITER (parallel chunks + retries, in WAVES via WriterLedger) ───────────────
  const writerStart = Date.now();
  input.signal?.throwIfAborted();
  const ledger = new WriterLedger({
    flowJson: input.flowJson,
    planner,
    model: input.model,
    reasoningEffort: input.writerReasoningEffort,
    generationId,
    phloUuid: input.phloUuid,
    provider: input.writerProvider,
    signal: input.signal,
    fallbackPolicy: mode === "stress" ? "skip-declines" : "full",
    incremental: input.incrementalEmit ?? true,
    genStart,
  });
  yield ledger.announceWriting(slots.length, slots.length);
  yield* ledger.runWave(slots, 0);

  // ── EXACT-COUNT TOP-UP (stress only, ONE bounded wave) ─────────────────────────
  // When declines/dedups leave saved < requested, allocate the shortfall as FRESH
  // slots (every first-wave coverage_key excluded — re-planning a declined key would
  // just re-decline) and push them through the same wave machinery. Best-effort: a
  // top-up failure never discards the first wave's results. Runs BEFORE the
  // all-failed check so a fully-declined first wave still gets its rescue shot.
  // Skipped when wave 1 was capacity-limited: its allocation already exhausted the
  // fully-expanded pool, so re-allocating (minus the used keys) is guaranteed-zero
  // yield for seconds of synchronous enumeration.
  let topupPlanned = 0;
  let topupSaved = 0;
  if ((input.exactCountTopUp ?? true) && mode === "stress" && !capacityLimited && ledger.saved < input.maxScenarios) {
    input.signal?.throwIfAborted();
    const shortfall = input.maxScenarios - ledger.saved;
    const usedKeys: Set<string> = new Set(slots.map((s) => s.coverage_key));
    try {
      const topup = allocateScenarioSlots(planner, shortfall, existing, {
        excludeKeys: usedKeys,
        slotIdOffset: slots.length,
        coreCoverageExempt: true,
      });
      if (topup.slots.length > 0) {
        topupPlanned = topup.slots.length;
        const savedBefore = ledger.saved;
        console.log(
          `[sim-gen] top-up generation=${generationId} shortfall=${shortfall} topup_planned=${topupPlanned} pool_expanded=${topup.audit.pool_expanded}`,
        );
        // Re-announce with CUMULATIVE totals: top-up chunk events carry chunk_index
        // ≥ the first announcement's chunk_count otherwise ("chunk 5 of 4").
        yield ledger.announceWriting(topupPlanned, slots.length + topupPlanned);
        yield* ledger.runWave(topup.slots, ledger.totalChunks);
        topupSaved = ledger.saved - savedBefore;
      }
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[sim-gen] top-up failed (generation ${generationId}): ${(err as Error).message}`);
    }
  }
  const plannedTotal = slots.length + topupPlanned;

  // All-failed: every planned slot (and any top-up) failed and nothing was saved.
  // Throw (the route's catch emits an SSE `error` event) instead of a
  // `completed`/metadata event — mirrors aiassist, which emits `type:"error"` and no
  // `completed` when count==0. Emitting a completed event with partial_success=true
  // here would make the console show "completed" AND a partial-success banner
  // implying scenarios exist, when none were saved.
  if (ledger.saved === 0 && plannedTotal > 0) {
    throw new Error("Scenario generation failed for all planned slots.");
  }

  const writerMs = Date.now() - writerStart;
  // Full ledger in one greppable line (saved + failed + deduped = planned): the
  // 2026-07-14 "saved=10/40" investigation needed SSE-event archaeology to learn
  // planned/failed/deduped — never again.
  // Per-STAGE token roll-up alongside the per-stage timings, so one grep answers
  // "what did these N scenarios cost, where did the tokens go, and how long did each
  // stage take". The per-call `[llm] usage` lines stay the source of truth.
  //
  // The ALLOCATOR is absent here on purpose, not by oversight: it is pure deterministic
  // enumeration with no LLM call (see allocateScenarioSlots), so its token cost is
  // structurally zero and `allocation_ms` is its whole story. Emitting a hardcoded
  // `allocation_tokens=0` would imply it was measured and could one day be non-zero.
  const { usage: plannerU, calls: plannerCalls } = sumUsage(plannerUsages);
  const { usage: writerU, calls: writerCalls } = sumUsage(ledger.usages);
  // No cost_usd here, deliberately. Costing needs a PROVIDER name, and this whole
  // module tree (generate/planner/writer/allocator) takes everything through
  // GenerateInput and imports no config — which is what lets the gen tests run
  // without parsing real env. Importing config, or plumbing a provider name through
  // GenerateInput, to print one log field would trade that invariant for nothing:
  // the per-call `[llm] usage` lines already carry both cost_usd AND
  // correlation_id=<generation-id>, so generation cost is a group-by away:
  //   phrase "[llm] usage" AND correlation_id=<id>  ->  sum(cost_usd)
  console.log(
    `[sim-gen] timing generation=${generationId} planner_ms=${plannerMs} allocation_ms=${allocationMs} writer_ms=${writerMs} ttfs_ms=${ledger.ttfsMs} saved=${ledger.saved}/${plannedTotal} requested=${input.maxScenarios} failed=${ledger.failedSlotIds.length} deduped=${ledger.deduped} topup_planned=${topupPlanned} topup_saved=${topupSaved} capacity_limited=${capacityLimited} ` +
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
      planned_count: plannedTotal,
      saved_count: ledger.saved,
      failed_count: ledger.failedSlotIds.length,
      failed_slot_ids: ledger.failedSlotIds,
      deduped_count: ledger.deduped,
      // Partial success requires at least one saved scenario (aiassist parity) and
      // measures against what the USER asked for, not internal planning volume: a
      // topped-up run that delivered the full request is a success even though
      // plannedTotal exceeds it, and a capacity-limited short delivery is partial
      // even though every planned slot saved. Smoke's request is its unit list, so
      // plannedTotal is the honest denominator there.
      partial_success: ledger.saved > 0 && ledger.saved < (mode === "stress" ? input.maxScenarios : plannedTotal),
      capacity_limited: capacityLimited,
      topup_planned: topupPlanned,
      topup_saved: topupSaved,
      planner_usage: plannerUsage,
      writer_usages: ledger.usages,
      ...(mode === "smoke"
        ? { smoke_cap: smokeCap, smoke_units_hash: alloc.smokeUnitsHash, dropped_unit_ids: alloc.droppedUnitIds }
        : {}),
      planner_ms: plannerMs,
      allocation_ms: allocationMs,
      writer_ms: writerMs,
      ttfs_ms: ledger.ttfsMs,
      planner_cache_hit: plannerCacheHit,
      incremental_disabled: ledger.incrementalDisabled,
    },
  };
}
