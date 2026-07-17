import { describe, test, expect, mock } from "bun:test";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => ({
  ...TEST_CONFIG_MODULE_DEFAULTS,
  config: { LLM_PROVIDER: "anthropic", JUDGE_MODEL: undefined, SIMULATOR_MODEL: undefined, GENERATOR_MODEL: undefined, LLM_TIMEOUT_MS: 30000, LLM_MAX_RETRIES: 1 },
}));

const { validateAndFixScenario, runtimeConfig, normalizeTraits, writeScenarioChunk, writerContextNodes } = await import("../src/sim-engine/gen/writer.js");
const { MockLLM } = await import("../src/llm/index.js");
import type { Slot } from "../src/sim-engine/gen/types.js";

const slot: Slot = {
  slot_id: "S001",
  capability_id: "handle_refund",
  capability_name: "Handle refund",
  scenario_type: "recovery_success",
  conversation_pattern_id: "fragmented_entity",
  persona_combo_id: "P05",
  entity_format_combo_id: "E07",
  runtime_stress_combo_id: "R02", // interruption ON
  route_id: "n-greet:wants_refund",
  mock_profile_id: "M_SUCCESS",
  simulation_mode: "stress",
  expected_business_outcome: "handle_refund",
  expected_route_outcome: { source_node_id: "n-greet", expected_intent_name: "wants_refund", target_node_id: "", target_node_name: "", target_node_type: "branch_v2" },
  required_mocked_actions: [],
  variable_anchors: ["order_id"],
  coverage_key: "handle_refund|recovery_success|fragmented_entity|P05|E07|R02|n-greet:wants_refund|M_SUCCESS",
};

const writerScenario = () => ({
  name: "Refund with partial order",
  persona: { personality: "", emotional_state: "", behavioral_traits: ["interrupts"], details_json: '{"caller_name":"Sam"}' },
  goal: "Get a refund for an eligible order",
  language: "en-US",
  world_state: [{ node_id: "n-check", outcome: "eligible", data_json: '{"order_id":"A1"}', action_mocks_json: "{}" }],
  start_node_params_json: "{}",
  tags: [],
});

describe("runtimeConfig", () => {
  test("maps stress combos to runtime flags", () => {
    expect(runtimeConfig("R02").interruption).toEqual({ enabled: true, probability: 0.3 });
    expect(runtimeConfig("R00")).toEqual({ interruption: { enabled: false, probability: 0 }, stt_noise: { enabled: false, severity: "light" }, non_answer: { enabled: false, probability: 0 } });
    expect(runtimeConfig("R03").stt_noise).toEqual({ enabled: true, severity: "medium" });
  });
});

describe("normalizeTraits", () => {
  test("canonicalizes aliases, dedups, appends fallback, caps at 4", () => {
    expect(normalizeTraits(["interrupts", "cooperative"], ["hesitant", "cooperative"])).toEqual(["rushes", "cooperative", "hesitant"]);
    expect(normalizeTraits(["a", "b", "c", "d", "e"], ["self_corrects", "rushes", "hesitant", "cooperative", "goes_off_topic"]).length).toBe(4);
  });
});

describe("validateAndFixScenario (with slot)", () => {
  const fixed = validateAndFixScenario(writerScenario(), slot, "gen-1", "Refund agent.", ["caller_name"])!;

  test("world_state array → dict; *_json blobs unpacked", () => {
    expect(fixed.world_state).toEqual({ "n-check": { outcome: "eligible", data: { order_id: "A1" } } });
    expect(fixed.persona.details).toEqual({ caller_name: "Sam" });
  });

  test("persona filled from the combo; traits canonicalized", () => {
    expect(fixed.persona.personality).toBe("confused"); // P05.style fallback
    expect(fixed.persona.behavioral_traits).toContain("rushes"); // interrupts→rushes
    expect(fixed.persona.behavioral_traits).toContain("gives_partial_info"); // P05 fallback trait
  });

  test("runtime config from the slot's stress combo (R02 → interruption)", () => {
    expect(fixed.interruption).toEqual({ enabled: true, probability: 0.3 });
    expect(fixed.stt_noise.enabled).toBe(false);
  });

  test("eval_metadata stamped; tags sorted + prefixed; interruption tag", () => {
    expect(fixed.eval_metadata!.coverage_key).toBe(slot.coverage_key);
    expect(fixed.eval_metadata!.slot_id).toBe("S001");
    expect(fixed.tags).toContain("capability:handle_refund");
    expect(fixed.tags).toContain("pattern:fragmented_entity");
    expect(fixed.tags).toContain("interruption");
    expect([...fixed.tags]).toEqual([...fixed.tags].sort()); // sorted
  });

  test("ensureStartNodeParams fills from persona details", () => {
    expect(fixed.start_node_params.caller_name).toBe("Sam");
  });

  test("rejects a scenario missing name/goal → null", () => {
    expect(validateAndFixScenario({ persona: {}, goal: "g", world_state: [], tags: [] }, slot, "g", "", [])).toBeNull();
    expect(validateAndFixScenario({ name: "x", world_state: [], tags: [] }, slot, "g", "", [])).toBeNull();
  });

  test("a smoke slot stamps the smoke fields into eval_metadata + the smoke tags", () => {
    const smokeSlot: Slot = {
      ...slot,
      scenario_type: "clean_baseline",
      conversation_pattern_id: "clean_direct",
      persona_combo_id: "P01",
      entity_format_combo_id: "E01",
      runtime_stress_combo_id: "R00",
      simulation_mode: "smoke",
      smoke_unit_id: "handle_refund__happy_path__001",
      smoke_unit_kind: "happy_path",
      smoke_unit_description: "proves the refund happy path",
      smoke_units_hash: "abc123",
      coverage_key: "handle_refund|clean_baseline|clean_direct|P01|E01|R00|n-greet:wants_refund|M_SUCCESS",
    };
    const s = validateAndFixScenario(writerScenario(), smokeSlot, "gen-1", "Refund agent.", [])!;
    expect(s.eval_metadata!.simulation_mode).toBe("smoke");
    expect(s.eval_metadata!.smoke_unit_id).toBe("handle_refund__happy_path__001");
    expect(s.eval_metadata!.smoke_unit_kind).toBe("happy_path");
    expect(s.eval_metadata!.smoke_unit_description).toBe("proves the refund happy path");
    expect(s.eval_metadata!.smoke_units_hash).toBe("abc123");
    expect(s.tags).toContain("simulation_mode:smoke");
    expect(s.tags).toContain("smoke_kind:happy_path");
    // smoke = R00: no interruption/noise injected
    expect(s.interruption.enabled).toBe(false);
    expect(s.stt_noise.enabled).toBe(false);
  });
});

describe("writeScenarioChunk (LLM 2) with MockLLM", () => {
  const flow = { nodes: [{ id: "n-start", type: "start", data: { config: { name: "Start", payload_format: { caller_name: {} } } } }], edges: [] };
  const planner = { agent_flow_description: "Refund agent.", planner_rationale: "r" } as any;

  test("validates each scenario_item and stamps eval_metadata", async () => {
    const llm = new MockLLM([JSON.stringify({ agent_flow_description: "Refund agent.", scenario_items: [{ slot_id: "S001", scenario: writerScenario() }] })]);
    const res = await writeScenarioChunk({ flowJson: flow, planner, slots: [slot], model: "gpt-5.5-1", generationId: "gen-1", phloUuid: "a", chunkIndex: 0, attempt: 1, provider: llm });
    expect(res.scenarios.length).toBe(1);
    expect(res.failedSlotIds).toEqual([]);
    expect(res.scenarios[0].eval_metadata!.slot_id).toBe("S001");
    expect(res.scenarios[0].world_state["n-check"].outcome).toBe("eligible");
  });

  test("a missing slot in the writer output is reported failed", async () => {
    const llm = new MockLLM([JSON.stringify({ agent_flow_description: "x", scenario_items: [] })]);
    const res = await writeScenarioChunk({ flowJson: flow, planner, slots: [slot], model: "gpt-5.5-1", generationId: "gen-1", phloUuid: "a", chunkIndex: 0, attempt: 1, provider: llm });
    expect(res.scenarios.length).toBe(0);
    expect(res.failedSlotIds).toEqual(["S001"]);
  });
});

describe("writerContextNodes (G1)", () => {
  test("filters to slot-route nodes + start and hoists config to top level", () => {
    const flow = {
      nodes: [
        { id: "n-start", type: "start", data: { config: { name: "Start" } } },
        { id: "n-greet", type: "ai_agent_v2", data: { config: { name: "greet", instructions: "say hi" } } },
        { id: "n-check", type: "branch_v2", data: { config: { name: "check" } } },
        { id: "n-unrelated", type: "ai_agent_v2", data: { config: { name: "other" } } },
      ],
      edges: [],
    };
    const s: Slot = {
      ...slot,
      expected_route_outcome: {
        source_node_id: "n-greet",
        expected_intent_name: "wants_refund",
        target_node_id: "n-check",
        target_node_name: "check",
        target_node_type: "branch_v2",
      },
    };
    const nodes = writerContextNodes(flow, [s]);
    // route source (n-greet) + target (n-check) + start; the unrelated node is excluded.
    expect(nodes.map((n) => n.id).sort()).toEqual(["n-check", "n-greet", "n-start"]);
    const greet = nodes.find((n) => n.id === "n-greet")!;
    // reshaped to {id,type,name,config} with config HOISTED (the writer prompt reads
    // nodes[].config.instructions — the G1 bug sent it nested under data).
    expect(greet).toEqual({ id: "n-greet", type: "ai_agent_v2", name: "greet", config: { name: "greet", instructions: "say hi" } });
    expect(greet.config.instructions).toBe("say hi");
    expect((greet as Record<string, unknown>).data).toBeUndefined();
  });
});
