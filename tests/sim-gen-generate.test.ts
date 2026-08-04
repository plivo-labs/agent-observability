import { describe, test, expect, mock } from "bun:test";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => ({
  ...TEST_CONFIG_MODULE_DEFAULTS,
  config: { LLM_PROVIDER: "anthropic", JUDGE_MODEL: undefined, SIMULATOR_MODEL: undefined, GENERATOR_MODEL: undefined, LLM_TIMEOUT_MS: 30000, LLM_MAX_RETRIES: 1 },
}));

const { generateScenarios } = await import("../src/sim-engine/gen/generate.js");
const { MockLLM } = await import("../src/llm/index.js");
const { normalizeFlow } = await import("../src/simulation/flow/flow-normalize.js");
const realShape = (await import("./fixtures/flow-real-shape.json")).default;
import type { GenEvent } from "../src/sim-engine/gen/generate.js";
import type { ProviderCompleteArgs } from "../src/sim-engine/../llm/types.js";
// Static import is hoisted above the mock.module call, but the fixture is
// runtime-inert (type-only imports + literals) so the config mock is unaffected.
import { PLANNER_JSON } from "./fixtures/planner.js";

const canonical = normalizeFlow(realShape) as unknown as Record<string, any>;

// Adaptive writer: returns one valid scenario per requested slot_id.
const writerResponder = (args: ProviderCompleteArgs): string => {
  const payload = JSON.parse(args.user);
  const items = (payload.expected_slot_ids as string[]).map((id) => ({
    slot_id: id,
    scenario: { name: `Scenario ${id}`, persona: { personality: "", emotional_state: "", behavioral_traits: [], details_json: "{}" }, goal: `Goal for ${id}`, language: "en-US", world_state: [], start_node_params_json: "{}", tags: [] },
  }));
  return JSON.stringify({ agent_flow_description: "Refund agent.", scenario_items: items });
};

async function collect(gen: AsyncGenerator<GenEvent>): Promise<GenEvent[]> {
  const out: GenEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("generateScenarios — full pipeline (MockLLM planner+writer, real allocator)", () => {
  test("emits ordered progress events + N scenarios with eval_metadata; coverage_keys unique", async () => {
    const events = await collect(
      generateScenarios({
        flowJson: canonical,
        phloUuid: "agent-1",
        maxScenarios: 4,
        model: "gpt-5.5-1",
        plannerProvider: new MockLLM([PLANNER_JSON]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const types = events.map((e) => e.type);
    // ordered phase markers
    expect(types.indexOf("planning_started")).toBeLessThan(types.indexOf("planning_done"));
    expect(types.indexOf("planning_done")).toBeLessThan(types.indexOf("allocation_started"));
    expect(types.indexOf("allocation_done")).toBeLessThan(types.indexOf("writing_started"));
    expect(types.indexOf("writing_started")).toBeLessThan(types.indexOf("scenario"));
    expect(types[types.length - 1]).toBe("metadata");

    const scenarios = events.filter((e) => e.type === "scenario").map((e) => (e as any).scenario);
    expect(scenarios.length).toBe(4);
    for (const s of scenarios) {
      expect(s.eval_metadata.coverage_key).toBeTruthy();
      expect(s.world_state).toBeDefined();
    }
    const keys = scenarios.map((s) => s.eval_metadata.coverage_key);
    expect(new Set(keys).size).toBe(keys.length); // deduped / unique

    const meta = events.find((e) => e.type === "metadata") as any;
    expect(meta.metadata.saved_count).toBe(4);
    expect(meta.metadata.failed_slot_ids).toEqual([]);
    expect(meta.metadata.deduped_count).toBe(0);
    expect(meta.metadata.partial_success).toBe(false);
    // P0 timing fields: numeric phase durations + a ttfs stamped at the first scenario.
    expect(meta.metadata.planner_ms).toBeGreaterThanOrEqual(0);
    expect(meta.metadata.allocation_ms).toBeGreaterThanOrEqual(0);
    expect(meta.metadata.writer_ms).toBeGreaterThanOrEqual(0);
    expect(meta.metadata.ttfs_ms).toBeGreaterThanOrEqual(0);
  });

  test("one chunk's thrown LlmError degrades to failed slots — other chunks' scenarios survive", async () => {
    // 12 slots → 2 chunks (10 + 2). The 2-slot chunk's writer call throws (sustained 429 /
    // timeout after completeJSON's retries); chunk 1's 10 scenarios must still stream, with
    // the 2 slots reported failed — previously the rejection discarded everything.
    const throwingWriter = (args: ProviderCompleteArgs): string => {
      const ids = JSON.parse(args.user).expected_slot_ids as string[];
      if (ids.length <= 2) throw new Error("429 rate limited");
      return writerResponder(args);
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical,
        phloUuid: "agent-1",
        maxScenarios: 12,
        model: "m",
        exactCountTopUp: false, // isolate wave-1 failure semantics from the top-up
        plannerProvider: new MockLLM([PLANNER_JSON]),
        writerProvider: new MockLLM([throwingWriter]),
      }),
    );
    const scenarios = events.filter((e) => e.type === "scenario");
    expect(scenarios.length).toBe(10);
    const meta = events.find((e) => e.type === "metadata") as Extract<GenEvent, { type: "metadata" }>;
    expect(meta.metadata.saved_count).toBe(10);
    expect(meta.metadata.failed_count).toBe(2);
    expect(meta.metadata.partial_success).toBe(true);
  });

  test("chunks emit in COMPLETION order — a slow chunk no longer gates a fast one", async () => {
    // 12 slots → 2 chunks (10 + 2). The 10-slot chunk (index 0) sleeps 50ms; the 2-slot
    // chunk (index 1) responds immediately. With the old Promise.all gate nothing emitted
    // until BOTH finished (index order); now chunk 1's scenarios stream first.
    const slowFirstChunk = async (args: ProviderCompleteArgs): Promise<string> => {
      const ids = JSON.parse(args.user).expected_slot_ids as string[];
      if (ids.length > 2) await Bun.sleep(50);
      return writerResponder(args);
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical,
        phloUuid: "agent-1",
        maxScenarios: 12,
        model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]),
        writerProvider: new MockLLM([slowFirstChunk]),
      }),
    );
    const chunkDones = events.filter((e) => e.type === "writer_chunk_done") as Array<Extract<GenEvent, { type: "writer_chunk_done" }>>;
    expect(chunkDones.map((e) => e.chunk_index)).toEqual([1, 0]); // completion order, not index order
    // The fast chunk's scenarios precede the slow chunk's writer_chunk_done.
    const types = events.map((e) => e.type);
    expect(types.indexOf("scenario")).toBeLessThan(types.lastIndexOf("writer_chunk_done"));
    // Ledger invariant unchanged: planned = saved + failed + deduped, nothing failed.
    // (The feasibility fallback legitimately reuses one coverage key at 12 slots on this
    // fixture, so exactly one dedup occurs — same as under the old index-order emission.)
    const meta = events.find((e) => e.type === "metadata") as Extract<GenEvent, { type: "metadata" }>;
    expect(meta.metadata.failed_count).toBe(0);
    expect(meta.metadata.saved_count + meta.metadata.deduped_count).toBe(meta.metadata.planned_count);
    expect(events.filter((e) => e.type === "scenario").length).toBe(meta.metadata.saved_count);
  });

  test("incremental: scenario events precede their chunk's writer_chunk_done; kill-switch parity", async () => {
    // MockLLM streams deltas, so incremental emission is ACTIVE by default: every
    // scenario surfaces from the token stream before its chunk's terminal event.
    const on = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 12, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const chunkDoneAt = new Map<number, number>();
    on.forEach((e, idx) => {
      if (e.type === "writer_chunk_done") chunkDoneAt.set((e as any).chunk_index, idx);
    });
    on.forEach((e, idx) => {
      if (e.type === "writer_scenario_done") expect(idx).toBeLessThan(chunkDoneAt.get((e as any).chunk_index)!);
    });
    // Kill-switch: identical ledger + identical scenario set, chunk-granular timing.
    const off = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 12, model: "m", incrementalEmit: false,
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const ledger = (evs: GenEvent[]) => {
      const m = (evs.find((e) => e.type === "metadata") as any).metadata;
      return { saved: m.saved_count, failed: m.failed_count, deduped: m.deduped_count };
    };
    expect(ledger(on)).toEqual(ledger(off));
    const slotIds = (evs: GenEvent[]) =>
      evs.filter((e) => e.type === "scenario").map((e: any) => e.scenario.eval_metadata.slot_id).sort();
    expect(slotIds(on)).toEqual(slotIds(off));
  });

  test("a slot emitted mid-stream in a FAILED attempt is not re-emitted or re-requested by the retry", async () => {
    // Attempt 1 streams one complete, valid item then dies as invalid JSON (truncated
    // envelope) → completeJSON retries internally. The already-emitted slot must appear
    // EXACTLY once on the wire even though the retry's stream re-produces it (the
    // writer's emittedThisCall set persists across the call's internal attempts).
    let firstUser: string | null = null;
    const flakyWriter = (args: ProviderCompleteArgs): string => {
      if (firstUser === null) {
        firstUser = args.user;
        const full = JSON.parse(writerResponder(args));
        const one = { agent_flow_description: full.agent_flow_description, scenario_items: [full.scenario_items[0]] };
        return JSON.stringify(one).slice(0, -1); // valid item streamed, envelope unparseable
      }
      return writerResponder({ ...args, user: firstUser }); // full valid envelope on retry
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([flakyWriter]),
      }),
    );
    const emitted = events.filter((e) => e.type === "scenario").map((e: any) => e.scenario.eval_metadata.slot_id);
    expect(new Set(emitted).size).toBe(emitted.length); // no slot twice
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.saved_count + meta.deduped_count).toBe(meta.planned_count);
    expect(meta.failed_count).toBe(0);
  });

  test("BLOCK regression: slots emitted mid-stream before EVERY attempt throws are saved, never failed", async () => {
    // Each writer call streams ONE valid item (emitted incrementally) and then dies:
    // the envelope is truncated (invalid JSON) and the internal retry returns garbage,
    // so every completeJSON call throws after emitting. Pre-fix, the chunk rejection
    // marked ALL slots failed — including the emitted (and downstream-persisted) ones,
    // breaking planned = saved + failed + deduped.
    const emitOneThenDie = (args: ProviderCompleteArgs): string => {
      let parseable = true;
      try {
        JSON.parse(args.user);
      } catch {
        parseable = false;
      }
      if (!parseable) return "not json"; // completeJSON's internal retry — fail it too
      const full = JSON.parse(writerResponder(args));
      const one = { agent_flow_description: full.agent_flow_description, scenario_items: [full.scenario_items[0]] };
      return JSON.stringify(one).slice(0, -1); // valid item streamed, envelope unparseable
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([emitOneThenDie]),
      }),
    );
    const emitted = events.filter((e) => e.type === "scenario").map((e: any) => e.scenario.eval_metadata.slot_id);
    expect(new Set(emitted).size).toBe(emitted.length); // each slot at most once
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    // Every emitted slot is saved; NONE of them may simultaneously appear failed.
    for (const id of emitted) expect(meta.failed_slot_ids).not.toContain(id);
    expect(meta.saved_count).toBe(emitted.length);
    expect(meta.saved_count + meta.failed_count + meta.deduped_count).toBe(meta.planned_count);
  });

  test("per-slot fallback rescues slots the chunk attempts keep missing (now parallel)", async () => {
    // Multi-slot calls always omit the LAST requested slot → both chunk attempts miss
    // it → the single-slot fallback (expected_slot_ids.length === 1) writes it.
    const omitLast = (args: ProviderCompleteArgs): string => {
      const ids = JSON.parse(args.user).expected_slot_ids as string[];
      const full = JSON.parse(writerResponder(args));
      if (ids.length > 1) full.scenario_items = full.scenario_items.filter((it: any) => it.slot_id !== ids[ids.length - 1]);
      return JSON.stringify(full);
    };
    const writerLlm = new MockLLM([omitLast]);
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: writerLlm,
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.failed_count).toBe(0);
    expect(meta.saved_count + meta.deduped_count).toBe(meta.planned_count);
    const singleSlotCalls = writerLlm.calls.filter((c) => JSON.parse(c.user).expected_slot_ids?.length === 1);
    expect(singleSlotCalls.length).toBeGreaterThanOrEqual(1); // the fallback actually ran
  });

  test("fallback fan-out is bounded: ≤ WRITER_FALLBACK_CONCURRENCY single-slot calls in flight", async () => {
    // Chunk-level calls THROW (transport-degraded provider) → EVERY slot lands in
    // the fallback. Thrown attempts (unlike clean omissions, which are now
    // model-declined and skip the fallback) keep the full rescue path. The burst
    // must stay bounded — but still parallel (the P3 win the bound must not revert).
    const { WRITER_FALLBACK_CONCURRENCY } = await import("../src/sim-engine/gen/combos.js");
    let inFlight = 0;
    let peak = 0;
    const degraded = async (args: ProviderCompleteArgs): Promise<string> => {
      const ids = JSON.parse(args.user).expected_slot_ids as string[];
      if (ids.length > 1) throw new Error("degraded provider: chunk call failed");
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10)); // hold the slot so overlap is observable
      inFlight -= 1;
      return writerResponder(args);
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([degraded]),
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.failed_count).toBe(0); // every slot rescued
    expect(meta.saved_count + meta.deduped_count).toBe(meta.planned_count);
    expect(peak).toBeGreaterThanOrEqual(2); // parallelism kept…
    expect(peak).toBeLessThanOrEqual(WRITER_FALLBACK_CONCURRENCY); // …but bounded
  });

  test("incremental_disabled: true when an attempt's extractor self-disables; false on a clean run", async () => {
    // Attempt 1 streams a non-writer shape (root array): the extractor disables and the
    // schema parse rejects it, so completeJSON retries; attempt 2 streams the valid
    // envelope. Output is correct (final parse authoritative) but mid-stream emission was
    // lost for an attempt — metadata must surface that directly (the disable paths are
    // otherwise silent; the only other symptom is an unexplained ttfs regression).
    // completeJSON's internal retry mutates args.user (repair feedback), so replay the
    // FIRST prompt into writerResponder — the retry must SUCCEED for the call to return
    // (a throw would discard the attempt's extractor state with the whole call).
    let firstUser: string | null = null;
    const flaky = (args: ProviderCompleteArgs): string => {
      if (firstUser === null) {
        firstUser = args.user;
        return '["not","an","object"]';
      }
      return writerResponder({ ...args, user: firstUser });
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([flaky]),
      }),
    );
    expect((events.find((e) => e.type === "metadata") as any).metadata.incremental_disabled).toBe(true);

    const clean = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([writerResponder]),
      }),
    );
    expect((clean.find((e) => e.type === "metadata") as any).metadata.incremental_disabled).toBe(false);
  });

  test("planner cache: an identical request reuses the plan (no second planner call); any input change misses", async () => {
    const { plannerCacheClear } = await import("../src/sim-engine/gen/planner-cache.js");
    plannerCacheClear();
    const base = { flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m", plannerCacheTtlMs: 60_000 };
    const plannerLlm = new MockLLM([PLANNER_JSON]);
    const run = () =>
      collect(generateScenarios({ ...base, plannerProvider: plannerLlm, writerProvider: new MockLLM([writerResponder]) }));

    const first = await run();
    expect(plannerLlm.calls.length).toBe(1);
    expect((first.find((e) => e.type === "metadata") as any).metadata.planner_cache_hit).toBe(false);

    const second = await run();
    expect(plannerLlm.calls.length).toBe(1); // served from cache — no new planner call
    const meta2 = (second.find((e) => e.type === "metadata") as any).metadata;
    expect(meta2.planner_cache_hit).toBe(true);
    expect(meta2.planner_usage).toBeNull(); // honest token accounting on a hit
    expect((second.find((e) => e.type === "planning_done") as any).cache_hit).toBe(true);
    // Same ledger either way.
    expect(meta2.saved_count).toBe((first.find((e) => e.type === "metadata") as any).metadata.saved_count);

    // Any planner-input change (here: instructions) is a different key → miss.
    await collect(
      generateScenarios({
        ...base,
        testCaseGenerationInstructions: "different",
        plannerProvider: plannerLlm,
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    expect(plannerLlm.calls.length).toBe(2);
    plannerCacheClear();
  });

  test("planner cache: ttl 0 (the default) disables caching entirely", async () => {
    const { plannerCacheClear } = await import("../src/sim-engine/gen/planner-cache.js");
    plannerCacheClear();
    const plannerLlm = new MockLLM([PLANNER_JSON]);
    const run = () =>
      collect(
        generateScenarios({
          flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
          plannerProvider: plannerLlm, writerProvider: new MockLLM([writerResponder]),
        }),
      );
    await run();
    await run();
    expect(plannerLlm.calls.length).toBe(2); // no reuse without a TTL
  });

  test("throws after the planner fails twice", async () => {
    const run = collect(
      generateScenarios({
        flowJson: canonical,
        phloUuid: "a",
        maxScenarios: 4,
        model: "gpt-5.5-1",
        plannerProvider: new MockLLM(["nope", "still nope"]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    await expect(run).rejects.toThrow(/Planner failed/);
  });
});

describe("generateScenarios — SMOKE mode (one scenario per planner smoke unit)", () => {
  // Derived from PLANNER_JSON (one fixture contract, not a copy) — the same two
  // capabilities with smoke_units attached per capability.
  const SMOKE_UNITS_BY_CAP: Record<string, unknown[]> = {
    handle_refund: [
      { unit_id: "handle_refund__happy_path__001", kind: "happy_path", scenario_type: "clean_baseline", description: "refund happy path" },
      { unit_id: "handle_refund__boundary__001", kind: "boundary", scenario_type: "boundary_pressure", description: "out of scope refusal" },
    ],
    handle_status: [
      { unit_id: "handle_status__happy_path__001", kind: "happy_path", scenario_type: "clean_baseline", description: "status happy path" },
    ],
  };
  const smokePlanner = JSON.parse(PLANNER_JSON);
  smokePlanner.capabilities = smokePlanner.capabilities.map((c: any) => ({
    ...c,
    smoke_units: SMOKE_UNITS_BY_CAP[c.capability_id] ?? [],
  }));
  const SMOKE_PLANNER_JSON = JSON.stringify(smokePlanner);

  test("smoke run: scenario count = unit count; smoke metadata + eval_metadata stamped", async () => {
    const events = await collect(
      generateScenarios({
        flowJson: canonical,
        phloUuid: "agent-1",
        maxScenarios: 50, // a hint at most in smoke — the unit count governs
        model: "m",
        simulationMode: "smoke",
        smokeCap: 20,
        plannerProvider: new MockLLM([SMOKE_PLANNER_JSON]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const scenarios = events.filter((e) => e.type === "scenario").map((e) => (e as any).scenario);
    expect(scenarios.length).toBe(3); // 3 units, NOT max_scenarios
    for (const s of scenarios) {
      expect(s.eval_metadata.simulation_mode).toBe("smoke");
      expect(s.eval_metadata.smoke_unit_id).toBeTruthy();
      expect(s.eval_metadata.smoke_units_hash).toMatch(/^[0-9a-f]{32}$/);
      expect(s.eval_metadata.runtime_stress_combo_id).toBe("R00");
      expect(s.eval_metadata.mock_profile_id).toBe("M_SUCCESS");
      expect(s.tags).toContain("simulation_mode:smoke");
    }
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.saved_count).toBe(3);
    expect(meta.smoke_cap).toBe(20);
    expect(meta.smoke_units_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(meta.dropped_unit_ids).toEqual([]);
  });

  test("a cleanly-omitted smoke unit KEEPS its solo fallback (decline economy is stress-only)", async () => {
    // The first two writer calls (the chunk attempts) cleanly omit one unit; the
    // solo fallback (call 3) writes it. Smoke has no top-up wave to compensate, so
    // applying the stress decline economy here would permanently shorten the suite
    // — the economy must stay off in smoke mode.
    let omit: string | null = null;
    let calls = 0;
    const declineTwice = (args: ProviderCompleteArgs): string => {
      calls++;
      const ids = JSON.parse(args.user).expected_slot_ids as string[];
      omit ??= ids[ids.length - 1];
      const full = JSON.parse(writerResponder(args));
      if (calls <= 2) full.scenario_items = full.scenario_items.filter((it: any) => it.slot_id !== omit);
      return JSON.stringify(full);
    };
    const writerLlm = new MockLLM([declineTwice]);
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 50, model: "m",
        simulationMode: "smoke", smokeCap: 20,
        plannerProvider: new MockLLM([SMOKE_PLANNER_JSON]), writerProvider: writerLlm,
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.saved_count).toBe(3); // the omitted unit was rescued solo
    expect(meta.failed_count).toBe(0);
    expect(writerLlm.calls.length).toBe(3); // 2 chunk attempts + exactly 1 solo rescue
  });

  test("smoke cap drops overflow units and reports them in metadata", async () => {
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 50, model: "m",
        simulationMode: "smoke", smokeCap: 2,
        plannerProvider: new MockLLM([SMOKE_PLANNER_JSON]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const scenarios = events.filter((e) => e.type === "scenario");
    expect(scenarios.length).toBe(2);
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.smoke_cap).toBe(2);
    expect(meta.dropped_unit_ids).toEqual(["handle_status__happy_path__001"]); // lowest priority dropped
  });

  test("same-kind units under one capability (identical coverage_key) are NOT deduped away", async () => {
    // The dev E2E bug: units of the same capability + kind + route share all 8 coverage
    // axes; the within-run dedup (keyed by coverage_key) silently dropped 10/17 units.
    // Dedup must key on the audit-unique smoke_unit_id for smoke scenarios.
    const collidingPlanner = JSON.parse(PLANNER_JSON);
    collidingPlanner.capabilities = collidingPlanner.capabilities.map((c: any) => ({
      ...c,
      smoke_units:
        c.capability_id === "handle_refund"
          ? [
              { unit_id: "handle_refund__happy_path__001", kind: "happy_path", scenario_type: "clean_baseline", description: "collects order id" },
              { unit_id: "handle_refund__happy_path__002", kind: "happy_path", scenario_type: "clean_baseline", description: "confirms refund amount" },
            ]
          : [],
    }));
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 50, model: "m",
        simulationMode: "smoke", smokeCap: 20,
        plannerProvider: new MockLLM([JSON.stringify(collidingPlanner)]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const scenarios = events.filter((e) => e.type === "scenario").map((e) => (e as any).scenario);
    // Both colliding handle_refund units survive — nothing collapsed.
    const unitIds = scenarios.map((s: any) => s.eval_metadata.smoke_unit_id).sort();
    expect(unitIds).toContain("handle_refund__happy_path__001");
    expect(unitIds).toContain("handle_refund__happy_path__002");
    // The two colliding units really do share a coverage key (the bug's precondition).
    const keys = scenarios
      .filter((s: any) => s.eval_metadata.smoke_unit_id.startsWith("handle_refund__happy_path"))
      .map((s: any) => s.eval_metadata.coverage_key);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.deduped_count).toBe(0);
    expect(meta.saved_count).toBe(scenarios.length);
  });

  test("planner that omits smoke_units degrades to one fallback unit per capability", async () => {
    // PLANNER_JSON has no smoke_units — allocateSmokeSlots synthesizes {capId}__happy_path__001.
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 50, model: "m",
        simulationMode: "smoke", smokeCap: 20,
        plannerProvider: new MockLLM([PLANNER_JSON]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const scenarios = events.filter((e) => e.type === "scenario").map((e) => (e as any).scenario);
    expect(scenarios.length).toBe(2); // one per capability
    const unitIds = scenarios.map((s: any) => s.eval_metadata.smoke_unit_id).sort();
    expect(unitIds).toEqual(["handle_refund__happy_path__001", "handle_status__happy_path__001"]);
  });

  test("a cached plan that fails allocation replans honestly: cache_hit=false, usage captured, cache healed", async () => {
    const { plannerCacheClear, plannerCacheKey, plannerCacheSet } = await import("../src/sim-engine/gen/planner-cache.js");
    plannerCacheClear();
    // Poison the cache under the EXACT request key with a plan the smoke allocator
    // genuinely rejects: zero capabilities (a unit-less plan won't do — the allocator
    // synthesizes fallback units from capabilities). Forces the replan path off a
    // cache hit. (Field order must mirror generate.ts's plannerCacheKey call — the
    // key is a stringify of these parts.)
    // reasoningEffort is undefined here because the generateScenarios call below passes no
    // plannerReasoningEffort (the "inherit" default). Stated explicitly rather than omitted:
    // PlannerCacheKeyParts requires the field so a caller can't silently share one cache
    // entry across two effort settings, and JSON.stringify drops an undefined value anyway,
    // so the key this produces is byte-identical to the pre-effort key.
    const key = plannerCacheKey({
      flowJson: canonical, phloUuid: "a", model: "m", reasoningEffort: undefined,
      simulationMode: "smoke", smokeCap: 20, instructions: "", existingSummaries: [],
    });
    plannerCacheSet(key, { ...JSON.parse(PLANNER_JSON), capabilities: [] });
    const plannerLlm = new MockLLM([SMOKE_PLANNER_JSON]);
    const run = () =>
      collect(
        generateScenarios({
          flowJson: canonical, phloUuid: "a", maxScenarios: 50, model: "m",
          simulationMode: "smoke", smokeCap: 20, plannerCacheTtlMs: 60_000,
          plannerProvider: plannerLlm, writerProvider: new MockLLM([writerResponder]),
        }),
      );

    const events = await run();
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(plannerLlm.calls.length).toBe(1); // the replan ran a REAL planner call
    expect(meta.planner_cache_hit).toBe(false); // …so the run must not claim a hit
    expect(meta.planner_usage).not.toBeNull(); // …and its tokens are accounted
    expect(meta.saved_count).toBe(3); // the replanned (healthy) plan generated

    // The healed plan replaced the poisoned entry under the same key: an identical
    // rerun is a true hit with no further planner calls.
    const second = await run();
    expect(plannerLlm.calls.length).toBe(1);
    expect((second.find((e) => e.type === "metadata") as any).metadata.planner_cache_hit).toBe(true);
    plannerCacheClear();
  });

  test("stress metadata carries NO smoke fields", async () => {
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.smoke_cap).toBeUndefined();
    expect(meta.smoke_units_hash).toBeUndefined();
    expect(meta.dropped_unit_ids).toBeUndefined();
  });
});

describe("generateScenarios — G5 all-failed / partial", () => {
  const scen = (id: string) => ({
    slot_id: id,
    scenario: { name: `S ${id}`, persona: { personality: "", emotional_state: "", behavioral_traits: [], details_json: "{}" }, goal: "g", language: "en-US", world_state: [], start_node_params_json: "{}", tags: [] },
  });

  test("G5a: every slot failing throws (error event, not a completed/partial event)", async () => {
    const allFail = (): string => JSON.stringify({ agent_flow_description: "x", scenario_items: [] });
    await expect(
      collect(
        generateScenarios({
          flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
          plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([allFail]),
        }),
      ),
    ).rejects.toThrow(/all planned slots/);
  });

  test("G5a: a partial run keeps partial_success=true with saved>0", async () => {
    let accept: Set<string> | null = null;
    const partialWriter = (args: ProviderCompleteArgs): string => {
      const ids = (JSON.parse(args.user).expected_slot_ids as string[]);
      if (!accept) accept = new Set(ids.slice(0, Math.ceil(ids.length / 2))); // permanently accept the first half
      return JSON.stringify({ agent_flow_description: "x", scenario_items: ids.filter((id) => accept!.has(id)).map(scen) });
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([partialWriter]),
      }),
    );
    const meta = events.find((e) => e.type === "metadata") as Extract<GenEvent, { type: "metadata" }>;
    expect(meta.metadata.saved_count).toBeGreaterThan(0);
    expect(meta.metadata.saved_count).toBeLessThan(meta.metadata.planned_count);
    expect(meta.metadata.partial_success).toBe(true);
  });
});

describe("writer retry economy — model-declined slots skip the solo fallback", () => {
  test("a slot omitted by every CLEAN chunk attempt is failed without solo-fallback calls", async () => {
    // The provider answers healthily but never writes S004 (the low-capability-flow
    // decline pattern, 2026-07-14 prod: 18/40 slots burned 2 solo calls each for
    // zero yield). Expected calls: attempt 1 (4 slots) + attempt 2 (retry with the
    // 1 remaining slot) = exactly 2 — and NO solo fallback after the clean decline.
    const declineS004 = (args: ProviderCompleteArgs): string => {
      const full = JSON.parse(writerResponder(args));
      full.scenario_items = full.scenario_items.filter((it: any) => it.slot_id !== "S004");
      return JSON.stringify(full);
    };
    const writerLlm = new MockLLM([declineS004]);
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        exactCountTopUp: false, // isolate the decline economy from the top-up wave
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: writerLlm,
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.saved_count).toBe(3);
    expect(meta.failed_count).toBe(1);
    expect(meta.failed_slot_ids).toEqual(["S004"]);
    // Ledger invariant holds through the declined path too.
    expect(meta.saved_count + meta.failed_count + meta.deduped_count).toBe(meta.planned_count);
    // 2 chunk attempts total, zero solo-fallback calls (pre-fix: 4 calls).
    expect(writerLlm.calls.length).toBe(2);
  });

  test("a validation-REJECTED slot is not a decline: it keeps the solo fallback", async () => {
    // Both chunk attempts write S004 with an empty goal — writer-side validation
    // rejects it (rejectionReasons: missing_goal), so the model ENGAGED with the
    // slot; it didn't decline it. The focused solo call is exactly the rescue that
    // historically fixes this class. Pre-fix, absence from res.scenarios was
    // conflated with a clean decline and the slot failed with no solo call.
    let calls = 0;
    const badGoalTwice = (args: ProviderCompleteArgs): string => {
      calls++;
      const full = JSON.parse(writerResponder(args));
      if (calls <= 2) {
        full.scenario_items = full.scenario_items.map((it: any) =>
          it.slot_id === "S004" ? { ...it, scenario: { ...it.scenario, goal: "" } } : it,
        );
      }
      return JSON.stringify(full);
    };
    const writerLlm = new MockLLM([badGoalTwice]);
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        exactCountTopUp: false, // isolate the fallback path from the top-up wave
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: writerLlm,
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.saved_count).toBe(4); // S004 rescued by the solo retry
    expect(meta.failed_count).toBe(0);
    expect(writerLlm.calls.length).toBe(3); // 2 chunk attempts + exactly 1 solo rescue
  });

  test("slots missing because an attempt THREW keep the full solo fallback", async () => {
    // First chunk attempt dies mid-flight (transport), second attempt also thrown:
    // no CLEAN omission was ever observed, so every slot keeps the rescue path and
    // the run still completes fully via solo calls.
    const flaky = (args: ProviderCompleteArgs): string => {
      const ids = JSON.parse(args.user).expected_slot_ids as string[];
      if (ids.length > 1) throw new Error("transport blip");
      return writerResponder(args);
    };
    const writerLlm = new MockLLM([flaky]);
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: writerLlm,
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.failed_count).toBe(0); // every slot rescued by the fallback
    expect(meta.saved_count + meta.deduped_count).toBe(meta.planned_count);
  });
});


describe("exact-count top-up", () => {
  test("ONE top-up wave replaces declined slots with fresh coverage and reaches the requested count", async () => {
    // Wave 1: the model declines S004 on every clean attempt (fails after the decline
    // economy skips its solo fallback). Top-up: 1 fresh slot (new coverage_key, id
    // continuing after the planned wave) — the mock writes it → exact count.
    const declineS004 = (args: ProviderCompleteArgs): string => {
      const full = JSON.parse(writerResponder(args));
      full.scenario_items = full.scenario_items.filter((it: any) => it.slot_id !== "S004");
      return JSON.stringify(full);
    };
    const writerLlm = new MockLLM([declineS004]);
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: writerLlm,
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.saved_count).toBe(4); // exact count reached
    expect(meta.topup_planned).toBe(1);
    expect(meta.topup_saved).toBe(1);
    expect(meta.failed_count).toBe(1); // S004 stays honestly failed
    expect(meta.planned_count).toBe(5); // 4 first-wave + 1 top-up
    // Ledger invariant across waves: planned_total = saved + failed + deduped.
    expect(meta.saved_count + meta.failed_count + meta.deduped_count).toBe(meta.planned_count);
    // The USER's request was fully delivered — internal over-planning (5 planned
    // for a 4-ask) must not surface as a partial-success banner.
    expect(meta.partial_success).toBe(false);
    // The writer phase is re-announced for the top-up wave with CUMULATIVE totals,
    // so chunk events never exceed the last announced chunk_count.
    const ws = events.filter((e) => e.type === "writing_started") as any[];
    expect(ws.length).toBe(2);
    expect(ws[1].planned_count).toBe(5);
    expect(ws[1].chunk_count).toBe(2);
    // Every admitted scenario's coverage_key is unique across waves.
    const keys = events.filter((e) => e.type === "scenario").map((e: any) => e.scenario.eval_metadata.coverage_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a fully-declined first wave is rescued by the top-up instead of hard-failing", async () => {
    // Every wave-1 slot (S001..S004) is declined by both clean chunk attempts —
    // saved=0 after wave 1. Pre-fix the all-failed throw fired HERE, with the
    // top-up sitting unreachable one block below; now the top-up's fresh slots
    // (S005+) rescue the run and the throw fires only if THEY also fail.
    const wave1 = new Set(["S001", "S002", "S003", "S004"]);
    const declineWave1 = (args: ProviderCompleteArgs): string => {
      const full = JSON.parse(writerResponder(args));
      full.scenario_items = full.scenario_items.filter((it: any) => !wave1.has(it.slot_id));
      return JSON.stringify(full);
    };
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: new MockLLM([PLANNER_JSON]), writerProvider: new MockLLM([declineWave1]),
      }),
    );
    const meta = (events.find((e) => e.type === "metadata") as any).metadata;
    expect(meta.saved_count).toBe(4); // exact count via the rescue wave
    expect(meta.topup_planned).toBe(4);
    expect(meta.topup_saved).toBe(4);
    expect(meta.failed_slot_ids).toEqual(["S001", "S002", "S003", "S004"]);
    expect(meta.partial_success).toBe(false); // the request was fully delivered
    expect(meta.saved_count + meta.failed_count + meta.deduped_count).toBe(meta.planned_count);
  });

});
describe("generateScenarios — per-role reasoning effort", () => {
  // The two generation roles get INDEPENDENT dials: the planner does the hard
  // flow-comprehension work, the writer executes an already-fixed plan. Wiring them to
  // one value (or crossing them) would make the A/B that motivated these knobs
  // unattributable, so assert each reaches its own call.
  const run = (effort: { plannerReasoningEffort?: "none" | "low" | "medium" | "high"; writerReasoningEffort?: "none" | "low" | "medium" | "high" }) => {
    const plannerLlm = new MockLLM([PLANNER_JSON]);
    const writerLlm = new MockLLM([writerResponder]);
    return collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerProvider: plannerLlm, writerProvider: writerLlm, ...effort,
      }),
    ).then(() => ({ plannerLlm, writerLlm }));
  };

  test("each role's effort reaches only its own LLM call", async () => {
    const { plannerLlm, writerLlm } = await run({ plannerReasoningEffort: "high", writerReasoningEffort: "none" });
    expect(plannerLlm.calls[0]!.reasoningEffort).toBe("high");
    expect(writerLlm.calls[0]!.reasoningEffort).toBe("none");
  });

  test("unset (the \"inherit\" default) omits the parameter on both calls", async () => {
    // This is the merge-is-a-no-op guarantee: with nothing configured the wire shape
    // must be byte-identical to before the knobs existed.
    const { plannerLlm, writerLlm } = await run({});
    expect(plannerLlm.calls[0]!.reasoningEffort).toBeUndefined();
    expect(writerLlm.calls[0]!.reasoningEffort).toBeUndefined();
  });

  test("planner effort is part of the cache key, so two arms can't share a plan", async () => {
    // Without this the A/B is worthless: flipping the dial and regenerating the same
    // flow inside the TTL would replay the previous arm's cached plan and report a
    // difference of zero. Same flow + same model + different effort must MISS.
    const { plannerCacheClear } = await import("../src/sim-engine/gen/planner-cache.js");
    plannerCacheClear();

    const first = new MockLLM([PLANNER_JSON]);
    await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerReasoningEffort: "low", plannerCacheTtlMs: 60_000,
        plannerProvider: first, writerProvider: new MockLLM([writerResponder]),
      }),
    );
    expect(first.calls.length).toBe(1);

    // Same everything except effort → must call the planner again, not reuse the plan.
    const second = new MockLLM([PLANNER_JSON]);
    const events = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerReasoningEffort: "high", plannerCacheTtlMs: 60_000,
        plannerProvider: second, writerProvider: new MockLLM([writerResponder]),
      }),
    );
    expect(second.calls.length).toBe(1);
    const meta = events.find((e) => e.type === "metadata") as Extract<GenEvent, { type: "metadata" }>;
    expect(meta.metadata.planner_cache_hit).toBe(false);

    // Control: repeating an arm verbatim DOES hit, proving the miss above came from the
    // effort change and not from a key that never matches.
    const third = new MockLLM([PLANNER_JSON]);
    const again = await collect(
      generateScenarios({
        flowJson: canonical, phloUuid: "a", maxScenarios: 4, model: "m",
        plannerReasoningEffort: "high", plannerCacheTtlMs: 60_000,
        plannerProvider: third, writerProvider: new MockLLM([writerResponder]),
      }),
    );
    expect(third.calls.length).toBe(0);
    const againMeta = again.find((e) => e.type === "metadata") as Extract<GenEvent, { type: "metadata" }>;
    expect(againMeta.metadata.planner_cache_hit).toBe(true);
  });
});
