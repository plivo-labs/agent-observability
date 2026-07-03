import { describe, test, expect } from "bun:test";
import {
  PERSONA_COMBOS,
  ENTITY_FORMAT_COMBOS,
  RUNTIME_STRESS_COMBOS,
  MOCK_PROFILES,
  CONVERSATION_PATTERNS,
  SCENARIO_TYPES,
  SCENARIO_TYPE_DEFAULT_PATTERNS,
  ALLOCATION_AXES,
  HIGH_RISK_TRIPLES,
  PATTERN_PRIORITY,
  CANONICAL_TRAITS,
} from "../src/sim-engine/gen/combos.js";
import { PlannerOutputZ, WriterOutputZ, PLANNER_JSON_SCHEMA, WRITER_JSON_SCHEMA } from "../src/sim-engine/gen/schemas.js";

describe("combo libraries — exact counts + cross-reference integrity", () => {
  test("library sizes match aiassist", () => {
    expect(Object.keys(PERSONA_COMBOS).length).toBe(19);
    expect(Object.keys(ENTITY_FORMAT_COMBOS).length).toBe(8);
    expect(Object.keys(RUNTIME_STRESS_COMBOS).length).toBe(5);
    expect(Object.keys(MOCK_PROFILES).length).toBe(4);
    expect(Object.keys(CONVERSATION_PATTERNS).length).toBe(25);
    expect(ALLOCATION_AXES.length).toBe(8);
    expect(HIGH_RISK_TRIPLES.length).toBe(3);
    expect(CANONICAL_TRAITS.length).toBe(12);
  });

  test("every conversation pattern references real combos + valid scenario types", () => {
    const personaIds = new Set(Object.keys(PERSONA_COMBOS));
    const entityIds = new Set(Object.keys(ENTITY_FORMAT_COMBOS));
    const stressIds = new Set(Object.keys(RUNTIME_STRESS_COMBOS));
    const types = new Set<string>(SCENARIO_TYPES);
    for (const [id, p] of Object.entries(CONVERSATION_PATTERNS)) {
      for (const pid of p.persona_ids) expect(personaIds.has(pid), `${id} persona ${pid}`).toBe(true);
      expect(entityIds.has(p.entity_id), `${id} entity ${p.entity_id}`).toBe(true);
      expect(stressIds.has(p.stress_id), `${id} stress ${p.stress_id}`).toBe(true);
      for (const st of p.scenario_types) expect(types.has(st), `${id} type ${st}`).toBe(true);
    }
  });

  test("SCENARIO_TYPE_DEFAULT_PATTERNS keys = the 4 scenario types and reference real patterns", () => {
    expect(Object.keys(SCENARIO_TYPE_DEFAULT_PATTERNS).sort()).toEqual([...SCENARIO_TYPES].sort());
    const patternIds = new Set(Object.keys(CONVERSATION_PATTERNS));
    for (const [type, list] of Object.entries(SCENARIO_TYPE_DEFAULT_PATTERNS)) {
      for (const pid of list) {
        expect(patternIds.has(pid), `${type} → ${pid}`).toBe(true);
        // a pattern listed for a type must actually support that type
        expect(CONVERSATION_PATTERNS[pid].scenario_types.includes(type), `${pid} supports ${type}`).toBe(true);
      }
    }
  });

  test("PATTERN_PRIORITY keys + persona traits stay within their vocabularies", () => {
    const patternIds = new Set(Object.keys(CONVERSATION_PATTERNS));
    for (const pid of Object.keys(PATTERN_PRIORITY)) expect(patternIds.has(pid), `priority ${pid}`).toBe(true);
    const traits = new Set<string>(CANONICAL_TRAITS);
    for (const [id, persona] of Object.entries(PERSONA_COMBOS)) {
      for (const t of persona.behavioral_traits) expect(traits.has(t), `${id} trait ${t}`).toBe(true);
    }
  });
});

describe("planner + writer schemas", () => {
  const goodPlanner = {
    agent_flow_description: "A refund support agent.",
    capabilities: [
      {
        capability_id: "handle_refund",
        name: "Handle refund",
        description: "Process an eligible refund",
        priority: "core",
        risk: "high",
        source_signals: ["refund intent"],
        success_criteria: ["refund issued"],
      },
    ],
    planner_rationale: "Single core route.",
  };

  test("PlannerOutputZ accepts a minimal valid output and defaults the optional capability arrays", () => {
    const parsed = PlannerOutputZ.parse(goodPlanner);
    expect(parsed.capabilities[0].route_anchors).toEqual([]);
    expect(parsed.capabilities[0].smoke_units).toEqual([]);
    expect(parsed.blocked_or_deferred_outcomes).toEqual([]);
  });

  test("PlannerOutputZ rejects a capability missing a required field", () => {
    const bad = { ...goodPlanner, capabilities: [{ ...goodPlanner.capabilities[0], priority: undefined }] };
    expect(PlannerOutputZ.safeParse(bad).success).toBe(false);
    expect(PlannerOutputZ.safeParse({ ...goodPlanner, planner_rationale: undefined }).success).toBe(false);
  });

  const goodWriter = {
    agent_flow_description: "A refund support agent.",
    scenario_items: [
      {
        slot_id: "S001",
        scenario: {
          name: "Eligible refund",
          persona: { personality: "calm", emotional_state: "neutral", behavioral_traits: ["cooperative"], details_json: "{}" },
          goal: "Get a refund for an eligible order",
          language: "en-US",
          world_state: [{ node_id: "n-check", outcome: "eligible", data_json: "{}", action_mocks_json: "{}" }],
          start_node_params_json: "{}",
          tags: ["happy_path"],
        },
      },
    ],
  };

  test("WriterOutputZ accepts a valid chunk (array world_state, *_json strings)", () => {
    const parsed = WriterOutputZ.parse(goodWriter);
    expect(parsed.scenario_items[0].scenario.world_state[0].node_id).toBe("n-check");
  });

  test("WriterOutputZ rejects a scenario missing goal", () => {
    const bad = structuredClone(goodWriter);
    // @ts-expect-error deleting a required field for the negative test
    delete bad.scenario_items[0].scenario.goal;
    expect(WriterOutputZ.safeParse(bad).success).toBe(false);
  });

  test("raw JSON schemas are well-formed objects with the required roots", () => {
    expect((PLANNER_JSON_SCHEMA as any).required).toContain("capabilities");
    expect((WRITER_JSON_SCHEMA as any).required).toContain("scenario_items");
    expect((PLANNER_JSON_SCHEMA as any).additionalProperties).toBe(false);
    expect((WRITER_JSON_SCHEMA as any).additionalProperties).toBe(false);
  });
});
