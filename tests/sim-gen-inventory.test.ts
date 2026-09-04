import { describe, test, expect } from "bun:test";
import {
  flowHasOutboundCall,
  extractStartNodePayloadKeys,
  extractEmbeddedActions,
  containsOutOfScopeRouteTerm,
  nodeName,
  nodeConfig,
} from "../src/sim-engine/gen/inventory.js";

// The mechanical inventory (nodes / routes / variables / support) is built by the agent-runner
// walker and covered by its own tests. What stays in AO are the flow-shaping helpers the writer +
// planner read directly off the flow JSON — exercised here.

describe("flowHasOutboundCall (SER-6070)", () => {
  test("composite-only screening flow counts as outbound", () => {
    const flow = { nodes: [{ id: "s", type: "start" }, { id: "os", type: "outbound_screening" }, { id: "a", type: "ai_agent_v2" }] };
    expect(flowHasOutboundCall(flow)).toBe(true);
  });
  test("standalone contact_screening counts as outbound", () => {
    expect(flowHasOutboundCall({ nodes: [{ id: "sc", type: "contact_screening" }] })).toBe(true);
  });
  test("initiate_call counts as outbound", () => {
    expect(flowHasOutboundCall({ nodes: [{ id: "ic", type: "initiate_call" }] })).toBe(true);
  });
  test("chat-only flow stays inbound", () => {
    expect(flowHasOutboundCall({ nodes: [{ id: "a", type: "ai_agent_v2" }] })).toBe(false);
  });
});

describe("extractStartNodePayloadKeys", () => {
  test("returns the start node's payload_format keys", () => {
    const flow = { nodes: [{ id: "s", type: "start", data: { config: { payload_format: { caller_name: {}, to: {} } } } }] };
    expect(extractStartNodePayloadKeys(flow).sort()).toEqual(["caller_name", "to"]);
  });
  test("no start node / no payload_format → empty", () => {
    expect(extractStartNodePayloadKeys({ nodes: [{ id: "a", type: "ai_agent_v2" }] })).toEqual([]);
  });
});

describe("extractEmbeddedActions", () => {
  // An agent_node embeds actions exactly like ai_agent_v2 (SER-6078); both must surface a mock_key.
  const flow = {
    nodes: [
      { id: "s", type: "start" },
      {
        id: "an",
        type: "agent_node",
        data: {
          config: {
            name: "Collect Delivery Details",
            actions: [
              { action_type: "HTTP", http_tool_name: "lookup_order", http_tool_description: "Look the order up.", http_function_schema: { type: "object" } },
            ],
          },
        },
      },
    ],
  };
  test("an HTTP action on an agent_node yields a mock_key + description + stable schema_json", () => {
    expect(extractEmbeddedActions(flow)).toEqual([
      {
        node_uuid: "an",
        node_name: "Collect Delivery Details",
        actions: [
          { action_type: "HTTP", mock_key: "lookup_order", description: "Look the order up.", schema_json: JSON.stringify({ type: "object" }) },
        ],
      },
    ]);
  });
  test("a node type that carries no embedded actions is skipped", () => {
    expect(extractEmbeddedActions({ nodes: [{ id: "b", type: "branch_v2", data: { config: {} } }] })).toEqual([]);
  });
});

describe("containsOutOfScopeRouteTerm", () => {
  test("matches an out-of-scope telephony term anywhere in the values", () => {
    expect(containsOutOfScopeRouteTerm("route to voicemail")).toBe(true);
    expect(containsOutOfScopeRouteTerm("greet", "wants_refund")).toBe(false);
  });
});

describe("nodeName / nodeConfig", () => {
  test("nodeName prefers config.name, then meta.name, then id", () => {
    expect(nodeName({ id: "x", data: { config: { name: "Cfg" }, meta: { name: "Meta" } } })).toBe("Cfg");
    expect(nodeName({ id: "x", data: { meta: { name: "Meta" } } })).toBe("Meta");
    expect(nodeName({ id: "x", data: {} })).toBe("x");
  });
  test("nodeConfig hoists data.config", () => {
    expect(nodeConfig({ data: { config: { instructions: "hi" } } })).toEqual({ instructions: "hi" });
    expect(nodeConfig({ data: {} })).toEqual({});
  });
});
