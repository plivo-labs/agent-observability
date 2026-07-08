import { describe, test, expect } from "bun:test";
import {
  GenerateScenariosRequest,
  Scenario,
  parseFlowJson,
  FlowJsonError,
} from "../src/sim-engine/schema.js";
import realShape from "./fixtures/flow-real-shape.json";
import storedShape from "./fixtures/flow-stored-shape.json";

// A minimal valid scenario (worker SimulationScenario shape), reused below.
const validScenario = {
  id: "s1",
  name: "Eligible refund — calm caller",
  persona: { personality: "calm", emotional_state: "neutral", behavioral_traits: ["polite"], details: {} },
  goal: "Get a refund for an eligible order",
  language: "en-US",
  interruption: { enabled: false, probability: 0 },
  stt_noise: { enabled: false, severity: "light" as const },
  non_answer: { enabled: false, probability: 0 },
  world_state: { "n-check": { outcome: "eligible", data: { order_id: "A1" } } },
  start_node_params: {},
  max_turns: 25,
  tags: ["happy_path"],
};

describe("GenerateScenariosRequest (mirrors aiassist)", () => {
  test("parses a minimal body and applies aiassist defaults", () => {
    const r = GenerateScenariosRequest.parse({ flow_json: realShape, phlo_uuid: "agent-1" });
    expect(r.max_scenarios).toBe(50);
    expect(r.simulation_mode).toBe("stress");
    expect(r.test_case_generation_instructions).toBe("");
  });

  test("rejects max_scenarios out of [1,100] and a missing phlo_uuid", () => {
    expect(GenerateScenariosRequest.safeParse({ flow_json: realShape, phlo_uuid: "a", max_scenarios: 0 }).success).toBe(false);
    expect(GenerateScenariosRequest.safeParse({ flow_json: realShape, phlo_uuid: "a", max_scenarios: 101 }).success).toBe(false);
    expect(GenerateScenariosRequest.safeParse({ flow_json: realShape }).success).toBe(false);
  });

  test('accepts simulation_mode "smoke" VERBATIM (the old smoke→stress coercion is gone)', () => {
    const r = GenerateScenariosRequest.parse({ flow_json: realShape, phlo_uuid: "a", simulation_mode: "smoke" });
    expect(r.simulation_mode).toBe("smoke");
    expect(r.smoke_cap).toBeUndefined(); // optional — the route applies SMOKE_CAP_DEFAULT
  });

  test("smoke_cap is optional, bounded to [1,100]", () => {
    expect(GenerateScenariosRequest.parse({ flow_json: realShape, phlo_uuid: "a", simulation_mode: "smoke", smoke_cap: 5 }).smoke_cap).toBe(5);
    expect(GenerateScenariosRequest.safeParse({ flow_json: realShape, phlo_uuid: "a", smoke_cap: 0 }).success).toBe(false);
    expect(GenerateScenariosRequest.safeParse({ flow_json: realShape, phlo_uuid: "a", smoke_cap: 101 }).success).toBe(false);
  });

  test("rejects an unknown simulation_mode", () => {
    expect(GenerateScenariosRequest.safeParse({ flow_json: realShape, phlo_uuid: "a", simulation_mode: "chaos" }).success).toBe(false);
  });
});

describe("parseFlowJson — boundary gate via normalizeFlow", () => {
  test("accepts the canonical (console) shape → CanonicalFlow with nodes", () => {
    const flow = parseFlowJson(realShape);
    expect(flow.nodes.length).toBeGreaterThan(0);
  });

  test("accepts the stored (config-service) shape too", () => {
    const flow = parseFlowJson(storedShape);
    expect(flow.nodes.length).toBeGreaterThan(0);
  });

  test("throws a typed FlowJsonError on a structurally-empty flow", () => {
    expect(() => parseFlowJson({ nodes: [] })).toThrow(FlowJsonError);
    expect(() => parseFlowJson(null)).toThrow(FlowJsonError);
  });
});

describe("Scenario (matches the worker SimulationScenario struct)", () => {
  test("parses a valid scenario with a dict world_state", () => {
    const s = Scenario.parse(validScenario);
    expect(s.world_state["n-check"].outcome).toBe("eligible");
    expect(s.persona.behavioral_traits).toEqual(["polite"]);
  });

  test("passes through AO-only fields the worker ignores (eval_metadata)", () => {
    const s = Scenario.parse({ ...validScenario, eval_metadata: { capability_id: "C1" }, coverage_key: "C1|P01" });
    expect((s as Record<string, unknown>).coverage_key).toBe("C1|P01");
  });

  test("rejects an invalid stt_noise severity", () => {
    expect(Scenario.safeParse({ ...validScenario, stt_noise: { enabled: true, severity: "extreme" } }).success).toBe(false);
  });
});
