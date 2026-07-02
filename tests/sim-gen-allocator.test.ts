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
