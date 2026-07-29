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

// Minimal valid planner response, shared by every describe below.
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

// A planner payload must carry EXACTLY one flow representation — never both, never neither.
const expectExactlyOneFlowKey = (sent: Record<string, unknown>) => {
  const keys = [("flow_json" in sent) && "flow_json", ("flow_summary" in sent) && "flow_summary"].filter(Boolean);
  expect(keys.length).toBe(1);
};

describe("slug", () => {
  test("snake_cases + trims", () => {
    expect(slug("Handle Refund!")).toBe("handle_refund");
    expect(slug("  wants__refund  ")).toBe("wants_refund");
  });
});

describe("planCapabilities (LLM 1, loose) with MockLLM", () => {
  test("parses the planner output and attaches the mechanical inventory", async () => {
    const llm = new MockLLM([goodPlanner]);
    const { planner } = await planCapabilities({ flowJson: canonical, phloUuid: "agent-1", model: "gpt-5.5-1", provider: llm });
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
    const { planner } = await planCapabilities({ flowJson: canonical, phloUuid: "a", model: "m", provider: llm });
    const anchor = (planner.capabilities[0].route_anchors as Array<Record<string, unknown>>)[0];
    expect(anchor.source_node_id).toBe("n-greet");
    expect(anchor.target_node_id).toBe("n-check"); // filled from inventory (was "")
    expect(anchor.target_node_name).toBe("eligibility_check");
  });

  test("the planner payload includes the simulation surface + pattern library", async () => {
    const llm = new MockLLM([goodPlanner]);
    await planCapabilities({ flowJson: canonical, phloUuid: "agent-1", model: "gpt-5.5-1", provider: llm });
    const sent = JSON.parse(llm.calls[0].user);
    expect(sent.simulation_surface.executable_node_types).toContain("ai_agent_v2");
    expect(sent.conversation_pattern_library).toContain("clean_direct");
    expect(sent.simulation_mode).toBe("stress");
    expect(sent.smoke_cap).toBeUndefined(); // stress payloads never carry a cap
  });

  test("smoke mode: payload carries the REAL smoke_cap and the system prompt embeds it", async () => {
    const llm = new MockLLM([goodPlanner]);
    await planCapabilities({ flowJson: canonical, phloUuid: "agent-1", model: "m", simulationMode: "smoke", smokeCap: 12, provider: llm });
    const sent = JSON.parse(llm.calls[0].user);
    expect(sent.simulation_mode).toBe("smoke");
    expect(sent.smoke_cap).toBe(12); // the pre-smoke wiring gap sent 0 here
    expect(llm.calls[0].system).toContain("Emit at most 12 smoke units");
    expect(llm.calls[0].system).toContain("SMOKE coverage");
  });

  test("throws after exhausting retries on invalid JSON", async () => {
    const llm = new MockLLM(["not json", "still not json"]);
    await expect(
      planCapabilities({ flowJson: canonical, phloUuid: "a", model: "gpt-5.5-1", provider: llm }),
    ).rejects.toThrow();
  });

  test("reports fallbackUsed honestly: false on a usable plan, true when the LLM yields none", async () => {
    const healthy = new MockLLM([goodPlanner]);
    const healthyOut = await planCapabilities({ flowJson: canonical, phloUuid: "a", model: "m", provider: healthy });
    expect(healthyOut.fallbackUsed).toBe(false);

    // Valid planner JSON with ZERO capabilities → the deterministic fallback supplies them.
    const empty = new MockLLM([
      JSON.stringify({ agent_flow_description: "x", capabilities: [], planner_rationale: "none" }),
    ]);
    const fallbackOut = await planCapabilities({ flowJson: canonical, phloUuid: "a", model: "m", provider: empty });
    expect(fallbackOut.fallbackUsed).toBe(true);
    expect(fallbackOut.planner.capabilities.length).toBeGreaterThan(0); // fallback filled in
  });
});

describe("planCapabilities — smoke flow-summary payload diet (SIM_GEN_SMOKE_FLOW_SUMMARY)", () => {
  test("smoke + flag on: flow_summary replaces flow_json; routes duplicate dropped; inventory intact", async () => {
    const llm = new MockLLM([goodPlanner]);
    const out = await planCapabilities({
      flowJson: canonical, phloUuid: "agent-1", model: "m",
      simulationMode: "smoke", smokeCap: 12, smokeFlowSummary: true, provider: llm,
    });
    const sent = JSON.parse(llm.calls[0].user);
    expectExactlyOneFlowKey(sent);
    expect(sent.flow_json).toBeUndefined();
    expect(sent.flow_summary.agent_profile.system_prompt).toBe("You are Acme support. Be concise.");
    expect(sent.flow_summary.edge_topology.length).toBe(8);
    expect(sent.simulation_surface.routes).toBeUndefined(); // exact duplicate of inventory.routes — dropped
    expect(sent.mechanical_inventory.routes.length).toBe(3); // the grounding source is untouched
    expect(sent.smoke_cap).toBe(12);
    // The system prompt describes the summary payload, and the smoke suffix is unchanged.
    expect(llm.calls[0].system).toContain("flow_summary");
    expect(llm.calls[0].system).toContain("edge_topology");
    expect(llm.calls[0].system).toContain("SMOKE coverage");
    // The call reports what ran — the generate ledger prints these.
    expect(out.payloadVariant).toBe("summary");
    expect(out.payloadBytes).toBe(llm.calls[0].user.length);
    // The diet actually diets: same flow, same request, smaller payload than full mode.
    const fullLlm = new MockLLM([goodPlanner]);
    const fullOut = await planCapabilities({
      flowJson: canonical, phloUuid: "agent-1", model: "m", simulationMode: "smoke", smokeCap: 12, provider: fullLlm,
    });
    expect(out.payloadBytes).toBeLessThan(fullOut.payloadBytes);
  });

  test("smoke WITHOUT the flag keeps the historical full payload", async () => {
    const llm = new MockLLM([goodPlanner]);
    const out = await planCapabilities({
      flowJson: canonical, phloUuid: "agent-1", model: "m", simulationMode: "smoke", smokeCap: 12, provider: llm,
    });
    const sent = JSON.parse(llm.calls[0].user);
    expectExactlyOneFlowKey(sent);
    expect(sent.flow_json).toBeDefined();
    expect(sent.flow_summary).toBeUndefined();
    expect(sent.simulation_surface.routes.length).toBe(3);
    expect(out.payloadVariant).toBe("full");
  });

  test("stress is BYTE-IDENTICAL with and without the flag (the flag is smoke-only)", async () => {
    const flagged = new MockLLM([goodPlanner]);
    const unflagged = new MockLLM([goodPlanner]);
    await planCapabilities({ flowJson: canonical, phloUuid: "agent-1", model: "m", smokeFlowSummary: true, provider: flagged });
    await planCapabilities({ flowJson: canonical, phloUuid: "agent-1", model: "m", provider: unflagged });
    expect(flagged.calls[0].user).toBe(unflagged.calls[0].user);
    expect(flagged.calls[0].system).toBe(unflagged.calls[0].system);
  });
});
