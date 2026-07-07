import { describe, test, expect } from "bun:test";
import { scenarioTypeQuotas, allocateScenarioSlots, allocateCapabilityQuotas, existingCoverage } from "../src/sim-engine/gen/allocator.js";
import type { PlannerWithInventory } from "../src/sim-engine/gen/types.js";
import type { Capability } from "../src/sim-engine/gen/schemas.js";

function cap(id: string, risk: "high" | "medium" | "low", overrides: Partial<Capability> = {}): Capability {
  return {
    capability_id: id,
    name: id.replace(/_/g, " "),
    description: "d",
    priority: "core",
    risk,
    source_signals: ["s"],
    success_criteria: ["sc"],
    route_anchors: [{ source_node_id: "n-greet", intent_name: id, target_node_type: "branch_v2", support: "fully_executable" }],
    action_anchors: [],
    variable_anchors: ["order_id"],
    recommended_conversation_patterns: [],
    boundary_patterns: [],
    smoke_units: [],
    ...overrides,
  } as Capability;
}

function makePlanner(caps: Capability[]): PlannerWithInventory {
  return {
    agent_flow_description: "x",
    capabilities: caps,
    blocked_or_deferred_outcomes: [],
    planner_rationale: "r",
    mechanical_inventory: {
      nodes: [],
      routes: [],
      variables: [],
      actions: [],
      languages: ["en-US"],
      start_node_param_keys: [],
      is_outbound_call: false,
    },
  } as PlannerWithInventory;
}

describe("scenarioTypeQuotas — hand-computed", () => {
  test("matches aiassist for representative n", () => {
    expect(scenarioTypeQuotas(1)).toEqual({ clean_baseline: 0, messy_success: 1, recovery_success: 0, boundary_pressure: 0 });
    expect(scenarioTypeQuotas(2)).toEqual({ clean_baseline: 1, messy_success: 1, recovery_success: 0, boundary_pressure: 0 });
    expect(scenarioTypeQuotas(3)).toEqual({ clean_baseline: 1, messy_success: 1, recovery_success: 1, boundary_pressure: 0 });
    expect(scenarioTypeQuotas(4)).toEqual({ clean_baseline: 1, messy_success: 1, recovery_success: 1, boundary_pressure: 1 });
    expect(scenarioTypeQuotas(10)).toEqual({ clean_baseline: 1, messy_success: 6, recovery_success: 2, boundary_pressure: 1 });
    expect(scenarioTypeQuotas(50)).toEqual({ clean_baseline: 1, messy_success: 31, recovery_success: 12, boundary_pressure: 6 });
    expect(scenarioTypeQuotas(100)).toEqual({ clean_baseline: 2, messy_success: 62, recovery_success: 24, boundary_pressure: 12 });
  });

  test("every quota sums to n", () => {
    for (const n of [4, 7, 13, 25, 37, 60, 99]) {
      const q = scenarioTypeQuotas(n);
      expect(q.clean_baseline + q.messy_success + q.recovery_success + q.boundary_pressure).toBe(n);
    }
  });
});

describe("allocateCapabilityQuotas", () => {
  test("guarantees each core capability ≥1, sums to n, weights by risk (hand-computed)", () => {
    const caps = [cap("handle_a", "high"), cap("handle_b", "low")];
    // weights: a = 3(core)+2(high)+0.10(1 var) = 5.10 ; b = 3+0(low)+0.10 = 3.10.
    // n=10: each core +1, remaining 8 → floor(8·5.10/8.20)=4, floor(8·3.10/8.20)=3,
    // leftover 1 → highest fractional (a) → a=6, b=4.
    const quotas = allocateCapabilityQuotas(caps, 10, existingCoverage([]));
    expect(quotas.handle_a + quotas.handle_b).toBe(10);
    expect(quotas.handle_a).toBe(6);
    expect(quotas.handle_b).toBe(4);
  });

  test("core capabilities survive the top-n weight cut (audit requires all core covered)", () => {
    // Weights: boundary-high-anchored (2+2+3·0.25+0.10=5.35) and secondary-high (1+2+0.85)
    // both outweigh a plain low-risk core (3+0+0.10=3.10). With n=2 a pure weight slice
    // would cut the core cap — and auditAllocation throws whenever n ≥ coreCount and a core
    // cap has no coverage. Core must be seated first.
    const caps = [
      cap("core_plain", "low"),
      cap("boundary_hot", "high", { priority: "boundary", action_anchors: ["a1", "a2", "a3"] }),
      cap("secondary_hot", "high", { priority: "secondary", action_anchors: ["a1", "a2", "a3"] }),
    ];
    const quotas = allocateCapabilityQuotas(caps, 2, existingCoverage([]));
    expect(quotas.core_plain ?? 0).toBeGreaterThanOrEqual(1);
    expect(Object.values(quotas).reduce((a, b) => a + b, 0)).toBe(2);
  });

  test("n < coreCount keeps the original pure weight slice (audit waives core coverage there)", () => {
    // 3 plain core caps (weight 3.10 each) + one heavy boundary cap (2+2+0.75+0.10 = 4.85).
    // With n=2 < coreCount=3 the audit does NOT require core coverage, so the pre-fix
    // behavior — top-n by weight, boundary cap seated — must be preserved exactly.
    const caps = [
      cap("core_a", "low"),
      cap("core_b", "low"),
      cap("core_c", "low"),
      cap("boundary_hot", "high", { priority: "boundary", action_anchors: ["a1", "a2", "a3"] }),
    ];
    const quotas = allocateCapabilityQuotas(caps, 2, existingCoverage([]));
    expect(quotas.boundary_hot ?? 0).toBeGreaterThanOrEqual(1); // the weight winner keeps its seat
    expect(Object.values(quotas).reduce((a, b) => a + b, 0)).toBe(2);
  });

  test("an empty capability_id is keyed by slug(name) consistently (no orphan quota bucket)", () => {
    const caps = [cap("handle_a", "high"), cap("", "low", { name: "Weird Cap" })];
    const quotas = allocateCapabilityQuotas(caps, 4, existingCoverage([]));
    // The empty-id cap gets a slug bucket, not an empty-string key.
    expect(quotas["weird_cap"] ?? quotas["weird-cap"]).toBeGreaterThanOrEqual(1);
    expect(quotas[""]).toBeUndefined();
  });
});

describe("allocateScenarioSlots — deterministic", () => {
  const planner = makePlanner([cap("handle_refund", "high"), cap("handle_status", "medium")]);

  test("produces exactly n slots, audit valid, slot_ids S001..", () => {
    const r = allocateScenarioSlots(planner, 4);
    expect(r.slots.length).toBe(4);
    expect(r.audit.valid).toBe(true);
    expect(r.slots.map((s) => s.slot_id)).toEqual(["S001", "S002", "S003", "S004"]);
    // every slot carries a full coverage_key over the 8 axes
    for (const s of r.slots) expect(s.coverage_key.split("|").length).toBe(8);
  });

  test("clean_baseline slots only use M_SUCCESS", () => {
    const r = allocateScenarioSlots(planner, 10);
    for (const s of r.slots) {
      if (s.scenario_type === "clean_baseline") expect(s.mock_profile_id).toBe("M_SUCCESS");
    }
  });

  test("byte-identical output across two runs (the parity guard)", () => {
    const a = allocateScenarioSlots(planner, 10);
    const b = allocateScenarioSlots(planner, 10);
    expect(JSON.stringify(a.slots)).toBe(JSON.stringify(b.slots));
    expect(a.slots.map((s) => s.coverage_key)).toEqual(b.slots.map((s) => s.coverage_key));
  });

  test("per-type counts exactly match the scenario_type quotas", () => {
    const r = allocateScenarioSlots(planner, 10);
    const q = scenarioTypeQuotas(10);
    const counts: Record<string, number> = {};
    for (const s of r.slots) counts[s.scenario_type] = (counts[s.scenario_type] ?? 0) + 1;
    expect(counts.clean_baseline ?? 0).toBe(q.clean_baseline);
    expect(counts.messy_success ?? 0).toBe(q.messy_success);
    expect(counts.recovery_success ?? 0).toBe(q.recovery_success);
    expect(counts.boundary_pressure ?? 0).toBe(q.boundary_pressure);
  });
});
