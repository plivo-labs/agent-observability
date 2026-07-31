// Shared sim-gen planner fixtures — the ONE place the test capability/planner
// shapes are authored. Two consumers with two needs:
//   - allocator tests build a post-processing PlannerWithInventory via makePlanner()
//   - generate tests feed the RAW planner-LLM response (pre-inventory shape) to
//     MockLLM via PLANNER_JSON
// Both derive from the same cap() builder so the suites cannot drift.
import type { PlannerWithInventory } from "../../src/sim-engine/gen/types.js";
import type { Capability } from "../../src/sim-engine/gen/schemas.js";

export function cap(id: string, risk: "high" | "medium" | "low", overrides: Partial<Capability> = {}): Capability {
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

export function makePlanner(caps: Capability[]): PlannerWithInventory {
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

/** The canonical two-capability refund/status planner as the raw planner-LLM
 *  response — what MockLLM planner providers return in the generate tests. */
export const TWO_CAP_PLANNER = {
  agent_flow_description: "Refund agent.",
  capabilities: [
    cap("handle_refund", "high", {
      name: "Handle refund",
      route_anchors: [{ source_node_id: "n-greet", intent_name: "wants_refund", target_node_type: "branch_v2", support: "fully_executable" }],
    }),
    cap("handle_status", "medium", {
      name: "Handle status",
      variable_anchors: [],
      route_anchors: [{ source_node_id: "n-greet", intent_name: "check_status", target_node_type: "ai_agent_v2", support: "fully_executable" }],
    }),
  ],
  planner_rationale: "r",
};

export const PLANNER_JSON = JSON.stringify(TWO_CAP_PLANNER);
