import type { FlowInventory } from "../../src/sim-engine/gen/inventory.js";

// The agent-runner mechanical inventory (SER-6447) for tests/fixtures/flow-real-shape.json.
// AO no longer builds this locally — the generator consumes what the walker returns; this fixture
// mirrors that response for the real-shape flow (n-greet ai → n-check branch / n-refund ai → n-bye).
export const realShapeInventory: FlowInventory = {
  nodes: [],
  routes: [
    { route_id: "n-greet:wants_refund", source_node_id: "n-greet", source_node_name: "greet", source_node_type: "ai_agent_v2", intent_id: "wants_refund", intent_name: "wants_refund", intent_instructions: "", target_node_id: "n-check", target_node_name: "eligibility_check", target_node_type: "branch_v2", support: "fully_executable" },
    { route_id: "n-greet:other", source_node_id: "n-greet", source_node_name: "greet", source_node_type: "ai_agent_v2", intent_id: "other", intent_name: "other", intent_instructions: "", target_node_id: "n-refund", target_node_name: "refund", target_node_type: "ai_agent_v2", support: "fully_executable" },
    { route_id: "n-refund:done", source_node_id: "n-refund", source_node_name: "refund", source_node_type: "ai_agent_v2", intent_id: "done", intent_name: "done", intent_instructions: "", target_node_id: "n-bye", target_node_name: "bye", target_node_type: "end_conversation", support: "supported_terminal" },
  ],
  variables: [{ node_id: "n-greet", node_name: "greet", variable_name: "order_id", variable_instructions: "" }],
  actions: [],
  languages: ["en-US"],
  start_node_param_keys: ["caller_name"],
  is_outbound_call: false,
  simulatable: true,
  unsimulatable: [],
  entry_node_uuid: "n-greet",
  reachable_ai_nodes: ["n-greet", "n-refund"],
  mockable_nodes: [
    { node_uuid: "n-check", name: "eligibility_check", type: "branch_v2", outcome_handles: ["eligible", "no_match", "error"], default_outcome: "no_match" },
  ],
  terminals: ["n-bye"],
};
