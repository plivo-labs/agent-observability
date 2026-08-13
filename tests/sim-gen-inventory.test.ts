import { describe, test, expect } from "bun:test";
import { normalizeFlow } from "../src/simulation/flow/flow-normalize.js";
import { flowHasOutboundCall, buildFlowInventory } from "../src/sim-engine/gen/inventory.js";
import realShape from "./fixtures/flow-real-shape.json";

// buildFlowInventory runs on the canonical flow (output of normalizeFlow), mirroring
// aiassist's _build_flow_inventory. The fixture is a refund flow (start → greet →
// {check→notify→http→refund | bye}); only ai_agent_v2 nodes carry intents.
const inv = buildFlowInventory(normalizeFlow(realShape) as unknown as Record<string, any>);

describe("buildFlowInventory — nodes", () => {
  test("one entry per flow node, with config-derived fields", () => {
    expect(inv.nodes.length).toBe(7);
    const greet = inv.nodes.find((n) => n.id === "n-greet")!;
    expect(greet.type).toBe("ai_agent_v2");
    expect(greet.instructions).toContain("Greet the caller");
    expect(greet.intent_names).toEqual(["wants_refund", "other"]);
    expect(greet.extract_variables).toEqual(["order_id"]);
  });
});

describe("buildFlowInventory — routes (one per intent) + support classification", () => {
  const byId = (id: string) => inv.routes.find((r) => r.route_id === id)!;

  test("exactly three intent routes", () => {
    expect(inv.routes.length).toBe(3);
    expect(inv.routes.map((r) => r.route_id).sort()).toEqual(["n-greet:other", "n-greet:wants_refund", "n-refund:done"]);
  });

  test("support reflects the target node type", () => {
    // → n-check (branch_v2 ∈ EXECUTABLE)
    expect(byId("n-greet:wants_refund").target_node_id).toBe("n-check");
    expect(byId("n-greet:wants_refund").support).toBe("fully_executable");
    // → n-bye (end_conversation ∈ SUPPORTED_TERMINAL)
    expect(byId("n-greet:other").support).toBe("supported_terminal");
    expect(byId("n-refund:done").support).toBe("supported_terminal");
  });

  test("route carries intent metadata", () => {
    expect(byId("n-greet:wants_refund").intent_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(byId("n-greet:wants_refund").intent_name).toBe("wants_refund");
  });
});

describe("buildFlowInventory — variables / actions / languages / outbound / start params", () => {
  test("variables come from extract_variables", () => {
    expect(inv.variables).toEqual([
      { node_id: "n-greet", node_name: "greet", variable_name: "order_id", variable_instructions: "the caller's order number" },
    ]);
  });

  test("no embedded actions in this flow; en-US; inbound; no start params", () => {
    expect(inv.actions).toEqual([]);
    expect(inv.languages).toEqual(["en-US"]);
    expect(inv.is_outbound_call).toBe(false);
    expect(inv.start_node_param_keys).toEqual([]);
  });
});

// SER-6078: an agent_node keeps its fields under agent_tasks, not extract_variables, and
// embeds actions the same way ai_agent_v2 does. Both were invisible to the generator, so a
// writer building a scenario for an agent_node flow saw a node that collects nothing and had
// no mock_key to mock its actions with.
describe("buildFlowInventory — agent_node (agent_tasks)", () => {
  const agentNodeFlow = {
    nodes: [
      { id: "s", type: "start", data: { config: { name: "Start" } } },
      {
        id: "an",
        type: "agent_node",
        data: {
          config: {
            name: "Collect Delivery Details",
            agent_tasks: {
              variables: [
                { name: "order_number", instructions: "Ask for the order number.", type: "text" },
                { name: "delivery_date", instructions: "Ask which day suits them.", type: "date" },
              ],
              extract_only: [{ name: "sentiment", instructions: "How the caller sounded." }],
            },
            actions: [
              {
                action_type: "HTTP",
                http_tool_name: "lookup_order",
                http_tool_description: "Look the order up.",
                http_function_schema: { type: "object" },
              },
            ],
          },
        },
      },
    ],
  };
  const anInv = buildFlowInventory(agentNodeFlow as unknown as Record<string, any>);

  test("agent_tasks variables land in the inventory, carrying their collector type", () => {
    expect(anInv.variables).toEqual([
      {
        node_id: "an",
        node_name: "Collect Delivery Details",
        variable_name: "order_number",
        variable_instructions: "Ask for the order number.",
        variable_type: "text",
      },
      {
        node_id: "an",
        node_name: "Collect Delivery Details",
        variable_name: "delivery_date",
        variable_instructions: "Ask which day suits them.",
        variable_type: "date",
      },
      {
        node_id: "an",
        node_name: "Collect Delivery Details",
        variable_name: "sentiment",
        variable_instructions: "How the caller sounded.",
        variable_type: "",
      },
    ]);
  });

  test("the collector type is passed through, so a newly registered type needs no change here", () => {
    const withNewType = {
      nodes: [
        { id: "s", type: "start" },
        {
          id: "an",
          type: "agent_node",
          data: { config: { name: "N", agent_tasks: { variables: [{ name: "amount_owed", type: "number" }] } } },
        },
      ],
    };
    const got = buildFlowInventory(withNewType as unknown as Record<string, any>);
    expect(got.variables[0]!.variable_type).toBe("number");
  });

  test("the node summary lists agent_tasks fields alongside extract_variables", () => {
    expect(anInv.nodes.find((n) => n.id === "an")!.extract_variables).toEqual([
      "order_number",
      "delivery_date",
      "sentiment",
    ]);
  });

  test("embedded actions on an agent_node get a mock_key", () => {
    expect(anInv.actions).toEqual([
      {
        node_id: "an",
        node_name: "Collect Delivery Details",
        mock_key: "lookup_order",
        action_type: "HTTP",
        description: "Look the order up.",
      },
    ]);
  });
});

describe("flowHasOutboundCall (SER-6070)", () => {
  test("composite-only screening flow counts as outbound", () => {
    const flow = {
      nodes: [
        { id: "s", type: "start" },
        { id: "os", type: "outbound_screening" },
        { id: "a", type: "ai_agent_v2" },
      ],
    };
    expect(flowHasOutboundCall(flow)).toBe(true);
  });

  test("standalone contact_screening counts as outbound", () => {
    expect(flowHasOutboundCall({ nodes: [{ id: "sc", type: "contact_screening" }] })).toBe(true);
  });

  test("chat-only flow stays inbound", () => {
    expect(flowHasOutboundCall({ nodes: [{ id: "a", type: "ai_agent_v2" }] })).toBe(false);
  });
});
