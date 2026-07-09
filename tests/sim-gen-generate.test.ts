import { describe, test, expect, mock } from "bun:test";

mock.module("../src/config.js", () => ({
  config: { LLM_PROVIDER: "anthropic", JUDGE_MODEL: undefined, SIMULATOR_MODEL: undefined, GENERATOR_MODEL: undefined, LLM_TIMEOUT_MS: 30000, LLM_MAX_RETRIES: 1 },
}));

const { generateScenarios } = await import("../src/sim-engine/gen/generate.js");
const { MockLLM } = await import("../src/llm/index.js");
const { normalizeFlow } = await import("../src/simulation/flow/flow-normalize.js");
const realShape = (await import("./fixtures/flow-real-shape.json")).default;
import type { GenEvent } from "../src/sim-engine/gen/generate.js";
import type { ProviderCompleteArgs } from "../src/sim-engine/../llm/types.js";

const canonical = normalizeFlow(realShape) as unknown as Record<string, any>;

const PLANNER_JSON = JSON.stringify({
  agent_flow_description: "Refund agent.",
  capabilities: [
    { capability_id: "handle_refund", name: "Handle refund", description: "d", priority: "core", risk: "high", source_signals: ["s"], success_criteria: ["sc"], route_anchors: [{ source_node_id: "n-greet", intent_name: "wants_refund", target_node_type: "branch_v2", support: "fully_executable" }], action_anchors: [], variable_anchors: ["order_id"], recommended_conversation_patterns: [], boundary_patterns: [] },
    { capability_id: "handle_status", name: "Handle status", description: "d", priority: "core", risk: "medium", source_signals: ["s"], success_criteria: ["sc"], route_anchors: [{ source_node_id: "n-greet", intent_name: "check_status", target_node_type: "ai_agent_v2", support: "fully_executable" }], action_anchors: [], variable_anchors: [], recommended_conversation_patterns: [], boundary_patterns: [] },
  ],
  planner_rationale: "r",
});

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
