import { describe, test, expect } from "bun:test";
import {
  scenarioTypeQuotas,
  allocateScenarioSlots,
  allocateCapabilityQuotas,
  existingCoverage,
} from "../src/sim-engine/gen/allocator.js";
import {
  allocateSmokeSlots,
  flattenSmokeUnits,
  smokeFallbackUnits,
  smokeUnitsHash,
  modeQuotasSmoke,
  auditSmokeAllocation,
} from "../src/sim-engine/gen/smoke-allocator.js";
import type { PlannerWithInventory, Slot } from "../src/sim-engine/gen/types.js";
import type { Capability, SmokeUnit } from "../src/sim-engine/gen/schemas.js";

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
      is_outbound_call: false,
      simulatable: true,
      unsimulatable: [],
      entry_node_uuid: null,
      reachable_ai_nodes: [],
      mockable_nodes: [],
      terminals: [],
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

// ── SMOKE mode (port of aiassist test_smoke_mode.py contracts) ───────────────────

function smokeUnit(unitId: string, overrides: Partial<SmokeUnit> = {}): SmokeUnit {
  return {
    unit_id: unitId,
    kind: "happy_path",
    scenario_type: "clean_baseline",
    description: `proves ${unitId}`,
    ...overrides,
  } as SmokeUnit;
}

describe("allocateSmokeSlots — one clean slot per unit", () => {
  const planner = makePlanner([
    cap("handle_refund", "high", {
      smoke_units: [
        smokeUnit("handle_refund__happy_path__001"),
        smokeUnit("handle_refund__boundary__001", { kind: "boundary", scenario_type: "boundary_pressure" }),
      ],
    }),
    cap("handle_status", "medium", { smoke_units: [smokeUnit("handle_status__happy_path__001")] }),
  ]);

  test("one slot per unit, R00 + M_SUCCESS everywhere, smoke fields + hash stamped", () => {
    const r = allocateSmokeSlots({ planner, smokeCap: 20 });
    expect(r.slots.length).toBe(3);
    expect(r.audit.valid).toBe(true);
    expect(r.dropped_unit_ids).toEqual([]);
    expect(r.smoke_units_hash).toMatch(/^[0-9a-f]{32}$/);
    for (const s of r.slots) {
      expect(s.runtime_stress_combo_id).toBe("R00");
      expect(s.mock_profile_id).toBe("M_SUCCESS");
      expect(s.simulation_mode).toBe("smoke");
      expect(s.smoke_unit_id).toBeTruthy();
      expect(s.smoke_units_hash).toBe(r.smoke_units_hash);
      expect(s.coverage_key.split("|").length).toBe(8);
    }
    // slot ids follow the S001.. convention in priority order
    expect(r.slots.map((s) => s.slot_id)).toEqual(["S001", "S002", "S003"]);
    // unique coverage keys + unique unit ids
    expect(new Set(r.slots.map((s) => s.coverage_key)).size).toBe(3);
    expect(new Set(r.slots.map((s) => s.smoke_unit_id)).size).toBe(3);
  });

  test("clean unit → P01 persona, E01 entity, no outcome suffix; boundary unit → __boundary suffix", () => {
    const r = allocateSmokeSlots({ planner, smokeCap: 20 });
    const clean = r.slots.find((s) => s.smoke_unit_id === "handle_refund__happy_path__001")!;
    expect(clean.scenario_type).toBe("clean_baseline");
    expect(clean.persona_combo_id).toBe("P01");
    expect(clean.entity_format_combo_id).toBe("E01");
    expect(clean.expected_business_outcome).toBe("handle_refund");
    const boundary = r.slots.find((s) => s.smoke_unit_id === "handle_refund__boundary__001")!;
    expect(boundary.scenario_type).toBe("boundary_pressure");
    expect(boundary.expected_business_outcome).toBe("handle_refund__boundary");
    expect(boundary.smoke_unit_kind).toBe("boundary");
  });

  test("happy_path units sort before boundary within a capability; higher risk caps first", () => {
    const r = allocateSmokeSlots({ planner, smokeCap: 20 });
    // handle_refund is high risk → its units first; happy before boundary.
    expect(r.slots.map((s) => s.smoke_unit_id)).toEqual([
      "handle_refund__happy_path__001",
      "handle_refund__boundary__001",
      "handle_status__happy_path__001",
    ]);
  });

  test("over-cap drops the LOWEST-priority units and records dropped_unit_ids", () => {
    const r = allocateSmokeSlots({ planner, smokeCap: 2 });
    expect(r.slots.length).toBe(2);
    // handle_status (medium risk) is the lowest-priority unit → dropped.
    expect(r.dropped_unit_ids).toEqual(["handle_status__happy_path__001"]);
    expect(r.slots.map((s) => s.smoke_unit_id)).toEqual([
      "handle_refund__happy_path__001",
      "handle_refund__boundary__001",
    ]);
  });

  test("a unit pinning route_id resolves that anchor into expected_route_outcome", () => {
    const p = makePlanner([
      cap("handle_a", "high", {
        smoke_units: [smokeUnit("handle_a__happy_path__001", { route_id: "n-greet:handle_a" })],
      }),
    ]);
    const r = allocateSmokeSlots({ planner: p, smokeCap: 20 });
    expect(r.slots[0].route_id).toBe("n-greet:handle_a");
    expect(r.slots[0].expected_route_outcome.source_node_id).toBe("n-greet");
    expect(r.slots[0].expected_route_outcome.expected_intent_name).toBe("handle_a");
  });

  test("planner without smoke_units falls back to one clean unit per capability", () => {
    const p = makePlanner([cap("handle_a", "high"), cap("handle_b", "low")]);
    const r = allocateSmokeSlots({ planner: p, smokeCap: 20 });
    expect(r.slots.length).toBe(2);
    expect(r.slots.map((s) => s.smoke_unit_id).sort()).toEqual([
      "handle_a__happy_path__001",
      "handle_b__happy_path__001",
    ]);
    for (const s of r.slots) expect(s.scenario_type).toBe("clean_baseline");
  });

  test("no capabilities at all → throws", () => {
    expect(() => allocateSmokeSlots({ planner: makePlanner([]), smokeCap: 20 })).toThrow(/no capabilities or units/);
  });

  test("byte-identical output across two runs (determinism parity guard)", () => {
    const a = allocateSmokeSlots({ planner, smokeCap: 20 });
    const b = allocateSmokeSlots({ planner, smokeCap: 20 });
    expect(JSON.stringify(a.slots)).toBe(JSON.stringify(b.slots));
    expect(a.smoke_units_hash).toBe(b.smoke_units_hash);
  });

  test("scenario_type_quotas mirror the unit counts; messy/recovery always 0", () => {
    const r = allocateSmokeSlots({ planner, smokeCap: 20 });
    expect(r.scenario_type_quotas).toEqual({ clean_baseline: 2, messy_success: 0, recovery_success: 0, boundary_pressure: 1 });
  });
});

describe("smoke helpers", () => {
  test("smokeUnitsHash is order-independent and id-set-sensitive", () => {
    const h1 = smokeUnitsHash([{ unit_id: "a" }, { unit_id: "b" }]);
    const h2 = smokeUnitsHash([{ unit_id: "b" }, { unit_id: "a" }]);
    const h3 = smokeUnitsHash([{ unit_id: "a" }, { unit_id: "c" }]);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
  });

  test("flattenSmokeUnits skips units without unit_id and enriches with capability context", () => {
    const p = makePlanner([
      cap("handle_a", "high", { smoke_units: [smokeUnit("u1"), { kind: "happy_path", scenario_type: "clean_baseline", description: "no id" } as SmokeUnit] }),
    ]);
    const units = flattenSmokeUnits(p);
    expect(units.length).toBe(1);
    expect(units[0].capability_id).toBe("handle_a");
    expect(units[0].capability_risk).toBe("high");
    expect(units[0].route_anchors.length).toBe(1);
  });

  test("smokeFallbackUnits skips blocked-route capabilities", () => {
    const blocked = cap("handle_blocked", "low", {
      route_anchors: [{ source_node_id: "n-x", intent_name: "x", target_node_type: "branch_v2", support: "blocked" }],
    });
    const units = smokeFallbackUnits(makePlanner([cap("handle_ok", "low"), blocked]));
    expect(units.map((u) => u.capability_id)).toEqual(["handle_ok"]);
  });

  test("modeQuotasSmoke counts only smoke-legal types", () => {
    expect(
      modeQuotasSmoke([
        { scenario_type: "clean_baseline" },
        { scenario_type: "boundary_pressure" },
        { scenario_type: "clean_baseline" },
      ]),
    ).toEqual({ clean_baseline: 2, messy_success: 0, recovery_success: 0, boundary_pressure: 1 });
  });

  test("auditSmokeAllocation flags wrong runtime/mock/type and duplicate unit ids", () => {
    const base: Slot = {
      slot_id: "S001",
      capability_id: "c",
      capability_name: "c",
      scenario_type: "clean_baseline",
      conversation_pattern_id: "clean_direct",
      persona_combo_id: "P01",
      entity_format_combo_id: "E01",
      runtime_stress_combo_id: "R00",
      route_id: "r",
      mock_profile_id: "M_SUCCESS",
      expected_business_outcome: "c",
      expected_route_outcome: { source_node_id: "", expected_intent_name: "", target_node_id: "", target_node_name: "", target_node_type: "" },
      required_mocked_actions: [],
      variable_anchors: [],
      simulation_mode: "smoke",
      smoke_unit_id: "u1",
      coverage_key: "k1",
    };
    const bad = auditSmokeAllocation(
      [
        { ...base, runtime_stress_combo_id: "R02" },
        { ...base, slot_id: "S002", smoke_unit_id: "u2", mock_profile_id: "M_RECOVERABLE_FAILURE", coverage_key: "k2" },
        { ...base, slot_id: "S003", smoke_unit_id: "u3", scenario_type: "messy_success", coverage_key: "k3" },
        { ...base, slot_id: "S004", coverage_key: "k4" }, // duplicate unit id u1
      ],
      20,
    );
    expect(bad.valid).toBe(false);
    expect(bad.invalid_runtime_stress).toEqual(["S001"]);
    expect(bad.invalid_mock_profiles).toEqual(["S002"]);
    expect(bad.invalid_scenario_types).toEqual(["S003"]);
    expect(bad.duplicate_unit_ids).toEqual(["u1"]);
    // and a clean pass
    expect(auditSmokeAllocation([base], 20).valid).toBe(true);
  });
});
