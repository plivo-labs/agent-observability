import { describe, test, expect, mock } from "bun:test";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

// Mock config so importing the llm module (via planner) doesn't parse real env.
mock.module("../src/config.js", () => ({
  ...TEST_CONFIG_MODULE_DEFAULTS,
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

// The mechanical inventory is built by agent-runner; planCapabilities consumes it.
// This fixture mirrors what the walker returns for the real-shape flow: three executable routes,
// the first landing on the branch node the anchor-merge + backfill assertions key on.
const inventory = {
  nodes: [],
  routes: [
    { route_id: "n-greet:wants_refund", source_node_id: "n-greet", source_node_name: "greet", source_node_type: "ai_agent_v2", intent_id: "wants_refund", intent_name: "wants_refund", intent_instructions: "", target_node_id: "n-check", target_node_name: "eligibility_check", target_node_type: "branch_v2", support: "fully_executable" as const },
    { route_id: "n-greet:status", source_node_id: "n-greet", source_node_name: "greet", source_node_type: "ai_agent_v2", intent_id: "status", intent_name: "status", intent_instructions: "", target_node_id: "n-status", target_node_name: "status_node", target_node_type: "ai_agent_v2", support: "fully_executable" as const },
    { route_id: "n-greet:done", source_node_id: "n-greet", source_node_name: "greet", source_node_type: "ai_agent_v2", intent_id: "done", intent_name: "done", intent_instructions: "", target_node_id: "n-end", target_node_name: "bye", target_node_type: "end_conversation", support: "supported_terminal" as const },
  ],
  variables: [],
  actions: [],
  languages: [],
  is_outbound_call: false,
  simulatable: true,
  unsimulatable: [],
  entry_node_uuid: "n-greet",
  reachable_ai_nodes: ["n-greet"],
  mockable_nodes: [],
  terminals: ["n-end"],
};

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
    const { planner } = await planCapabilities({ flowJson: canonical, inventory, phloUuid: "agent-1", model: "gpt-5.5-1", provider: llm });
    expect(planner.capabilities[0].capability_id).toBe("handle_refund");
    // G2: an anchor-less capability is backfilled from the first executable inventory
    // route (was []), so the allocator gets a real route to expand.
    const anchors = planner.capabilities[0].route_anchors as Array<Record<string, unknown>>;
    expect(anchors.length).toBe(1);
    expect(anchors[0].target_node_id).toBe("n-check");
    // inventory attached for the allocator
    expect(planner.mechanical_inventory.routes.length).toBe(3);
    expect(planner.mechanical_inventory.is_outbound_call).toBe(false);
  });

  test("G2: merges inventory route targets onto a capability's route_anchor (was empty)", async () => {
    // The planner emits an anchor with only source_node_id + intent_name (as the LLM does);
    // capabilitiesWithRoutes must fill target_node_id/target_node_name from the inventory.
    const plannerWithAnchor = JSON.stringify({
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
          route_anchors: [
            // What the LLM emits — note NO target_node_id/target_node_name (the merge fills those).
            { source_node_id: "n-greet", intent_name: "wants_refund", target_node_type: "branch_v2", support: "fully_executable" },
          ],
        },
      ],
      planner_rationale: "One core route.",
    });
    const llm = new MockLLM([plannerWithAnchor]);
    const { planner } = await planCapabilities({ flowJson: canonical, inventory, phloUuid: "a", model: "m", provider: llm });
    const anchor = (planner.capabilities[0].route_anchors as Array<Record<string, unknown>>)[0];
    expect(anchor.source_node_id).toBe("n-greet");
    expect(anchor.target_node_id).toBe("n-check"); // filled from inventory (was "")
    expect(anchor.target_node_name).toBe("eligibility_check");
  });

  test("the planner payload includes the simulation surface + pattern library", async () => {
    const llm = new MockLLM([goodPlanner]);
    await planCapabilities({ flowJson: canonical, inventory, phloUuid: "agent-1", model: "gpt-5.5-1", provider: llm });
    const sent = JSON.parse(llm.calls[0].user);
    // the fetched inventory is embedded whole for the planner LLM to ground on
    expect(sent.mechanical_inventory.routes.length).toBe(3);
    expect(sent.simulation_surface.executable_node_types).toContain("ai_agent_v2");
    expect(sent.conversation_pattern_library).toContain("clean_direct");
    expect(sent.simulation_mode).toBe("stress");
    expect(sent.smoke_cap).toBeUndefined(); // stress payloads never carry a cap
  });

  test("smoke mode: payload carries the REAL smoke_cap and the system prompt embeds it", async () => {
    const llm = new MockLLM([goodPlanner]);
    await planCapabilities({ flowJson: canonical, inventory, phloUuid: "agent-1", model: "m", simulationMode: "smoke", smokeCap: 12, provider: llm });
    const sent = JSON.parse(llm.calls[0].user);
    expect(sent.simulation_mode).toBe("smoke");
    expect(sent.smoke_cap).toBe(12); // the pre-smoke wiring gap sent 0 here
    expect(llm.calls[0].system).toContain("Emit at most 12 smoke units");
    expect(llm.calls[0].system).toContain("SMOKE coverage");
  });

  test("throws after exhausting retries on invalid JSON", async () => {
    const llm = new MockLLM(["not json", "still not json"]);
    await expect(
      planCapabilities({ flowJson: canonical, inventory, phloUuid: "a", model: "gpt-5.5-1", provider: llm }),
    ).rejects.toThrow();
  });
});
