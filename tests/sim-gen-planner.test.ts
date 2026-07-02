import { describe, test, expect, mock } from "bun:test";

// Mock config so importing the llm module (via planner) doesn't parse real env.
mock.module("../src/config.js", () => ({
  config: {
    LLM_PROVIDER: "anthropic",
    JUDGE_MODEL: undefined,
    SIMULATOR_MODEL: undefined,
    GENERATOR_MODEL: undefined,
    LLM_TIMEOUT_MS: 30000,
    LLM_MAX_RETRIES: 1,
  },
}));

const { planCapabilities } = await import("../src/sim-engine/gen/planner.js");
const { slug } = await import("../src/sim-engine/gen/text.js"); // slug moved to the pure-leaf text module
const { MockLLM } = await import("../src/llm/index.js");
const { normalizeFlow } = await import("../src/simulation/flow/flow-normalize.js");
const realShape = (await import("./fixtures/flow-real-shape.json")).default;

const canonical = normalizeFlow(realShape) as unknown as Record<string, any>;

describe("slug", () => {
  test("snake_cases + trims", () => {
    expect(slug("Handle Refund!")).toBe("handle_refund");
    expect(slug("  wants__refund  ")).toBe("wants_refund");
  });
});

describe("planCapabilities (LLM 1, loose) with MockLLM", () => {
  const goodPlanner = JSON.stringify({
    agent_flow_description: "Refund agent.",
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
    planner_rationale: "One core route.",
  });

  test("parses the planner output and attaches the mechanical inventory", async () => {
    const llm = new MockLLM([goodPlanner]);
    const { planner } = await planCapabilities({ flowJson: canonical, phloUuid: "agent-1", model: "gpt-5.5-1", provider: llm });
    expect(planner.capabilities[0].capability_id).toBe("handle_refund");
    expect(planner.capabilities[0].route_anchors).toEqual([]); // optional → defaulted
    // inventory attached for the allocator
    expect(planner.mechanical_inventory.routes.length).toBe(3);
    expect(planner.mechanical_inventory.is_outbound_call).toBe(false);
  });

  test("the planner payload includes the simulation surface + pattern library", async () => {
    const llm = new MockLLM([goodPlanner]);
    await planCapabilities({ flowJson: canonical, phloUuid: "agent-1", model: "gpt-5.5-1", provider: llm });
    const sent = JSON.parse(llm.calls[0].user);
    expect(sent.simulation_surface.executable_node_types).toContain("ai_agent_v2");
    expect(sent.conversation_pattern_library).toContain("clean_direct");
    expect(sent.simulation_mode).toBe("stress");
  });

  test("throws after exhausting retries on invalid JSON", async () => {
    const llm = new MockLLM(["not json", "still not json"]);
    await expect(
      planCapabilities({ flowJson: canonical, phloUuid: "a", model: "gpt-5.5-1", provider: llm }),
    ).rejects.toThrow();
  });
});

