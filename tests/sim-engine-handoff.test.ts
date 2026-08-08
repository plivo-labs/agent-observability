import { describe, test, expect } from "bun:test";
import {
  buildHandoffGraph,
  computeHandoffPlan,
  type HandoffEntry,
} from "../src/sim-engine/run-engine/handoff-planner.js";
import { VariableStore } from "../src/sim-engine/run-engine/variable-renderer.js";
import { buildAgentConfig, buildAgentTasksAgentConfig, type AgentConfigNode } from "../src/sim-engine/run-engine/agent-config.js";
import type { WorldStateEntry } from "../src/sim-engine/schema.js";

// ── Flow builders (mirror the Go test helpers: aiNode / mockNode / terminalNode / edge) ──
// All node config lives under data.config (the canonical shape buildHandoffGraph parses).

type Dict = Record<string, unknown>;

function aiNode(id: string, name: string, intents: Dict[] | null): Dict {
  return { id, type: "ai_agent_v2", data: { config: { name, intents: intents ?? [] } } };
}
function mockNode(id: string, name: string, nodeType: string, intents: Dict[] | null): Dict {
  return { id, type: nodeType, data: { config: { name, intents: intents ?? [] } } };
}
function terminalNode(id: string, name: string, nodeType: string, endMessage: string): Dict {
  return { id, type: nodeType, data: { config: { name, end_message: endMessage } } };
}
function promptNode(id: string, name: string): Dict {
  return { id, type: "prompt", data: { config: { name } } };
}
function startNode(id: string): Dict {
  return { id, type: "start", data: { config: { name: "Start" } } };
}
function edge(source: string, target: string, handle: string, data?: Dict): Dict {
  const e: Dict = { id: `${source}-${target}`, source, target, sourceHandle: handle };
  if (data) e["data"] = data;
  return e;
}

function graphFrom(flow: Dict) {
  return buildHandoffGraph(flow);
}
function nodeOf(flow: Dict, id: string) {
  return buildHandoffGraph(flow).nodes.get(id)!;
}

// Narrowing helpers for the discriminated HandoffEntry.
function asAi(e: HandoffEntry): { node_uuid: string; model: Dict; template_vars: Record<string, string[]> } {
  if (!("node_uuid" in e)) throw new Error("expected AI-target entry");
  return e;
}
function asTerminal(e: HandoffEntry): { type: "end_conversation"; end_message: string } {
  if (!("type" in e)) throw new Error("expected terminal entry");
  return e;
}

describe("computeHandoffPlan — port of handoff_planner_test.go", () => {
  test("direct AI → AI", () => {
    const flow = {
      nodes: [startNode("S"), aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]), aiNode("B", "NodeB", null)],
      edges: [edge("S", "A", "http"), edge("A", "B", "int-X")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    const e = asAi(plan["X"]);
    expect(e.node_uuid).toBe("B");
    expect(typeof e.model).toBe("object");
  });

  test("skip http_request with world_state failure", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("H", "HttpN", "http_request", null),
        aiNode("B", "NodeB", null),
        aiNode("C", "NodeC", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "H", "int-X"), edge("H", "B", "success"), edge("H", "C", "failure")],
    };
    const ws: Record<string, WorldStateEntry> = { H: { outcome: "failure", data: {} } };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), ws, null);
    expect(asAi(plan["X"]).node_uuid).toBe("C");
  });

  test("skip http_request defaults to success without world_state", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("H", "HttpN", "http_request", null),
        aiNode("B", "NodeB", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "H", "int-X"), edge("H", "B", "success")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    expect(asAi(plan["X"]).node_uuid).toBe("B");
  });

  test("ai_action outcome resolves to intent UUID", () => {
    const actionIntents = [
      { id: "act-success-uuid", intent_name: "success" },
      { id: "act-error-uuid", intent_name: "error" },
    ];
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("AC", "ActionN", "ai_action", actionIntents),
        aiNode("B", "NodeB", null),
        aiNode("C", "NodeC", null),
      ],
      edges: [
        edge("S", "A", "http"),
        edge("A", "AC", "int-X"),
        edge("AC", "B", "act-success-uuid"),
        edge("AC", "C", "act-error-uuid"),
      ],
    };
    const ws: Record<string, WorldStateEntry> = { ActionN: { outcome: "error", data: {} } };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), ws, null);
    expect(asAi(plan["X"]).node_uuid).toBe("C");
  });

  test("terminal end_conversation", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("H", "HttpN", "http_request", null),
        terminalNode("E", "EndN", "end_conversation", "Bye"),
        aiNode("B", "NodeB", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "H", "int-X"), edge("H", "B", "success"), edge("H", "E", "failure")],
    };
    const ws: Record<string, WorldStateEntry> = { H: { outcome: "failure", data: {} } };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), ws, null);
    const e = asTerminal(plan["X"]);
    expect(e.type).toBe("end_conversation");
    expect(e.end_message).toBe("Bye");
  });

  test("terminal call_forward coerced to end_conversation", () => {
    const flow = {
      nodes: [startNode("S"), aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]), terminalNode("F", "ForwardN", "call_forward", "Transferring")],
      edges: [edge("S", "A", "http"), edge("A", "F", "int-X")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    const e = asTerminal(plan["X"]);
    expect(e.type).toBe("end_conversation");
    expect(e.end_message).toBe("Transferring");
  });

  test("call_forward with world_state routes to AI", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("F", "Transfer", "call_forward", null),
        terminalNode("E", "End", "end_conversation", "Done"),
        aiNode("B", "Handle Failed Transfer", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "F", "int-X"), edge("F", "E", "completed"), edge("F", "B", "no_answer")],
    };
    const ws: Record<string, WorldStateEntry> = { F: { outcome: "no_answer", data: {} } };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), ws, null);
    expect(asAi(plan["X"]).node_uuid).toBe("B");
  });

  test("call_forward nodeVars use the call_forward source id (NOT the AI node)", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("F", "Transfer", "call_forward", null),
        aiNode("B", "Handle Failed Transfer", null),
      ],
      edges: [
        edge("S", "A", "http"),
        edge("A", "F", "int-X"),
        edge("F", "B", "no_answer", { nodeVars: ["{{Transfer.dial_status}}"] }),
      ],
    };
    const ws: Record<string, WorldStateEntry> = { F: { outcome: "no_answer", data: {} } };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), ws, null);
    const tv = asAi(plan["X"]).template_vars;
    expect(tv["F"]).toEqual(["dial_status"]); // collected under the call_forward node id
    expect(tv["A"] ?? []).toEqual([]); // not under the AI node
  });

  test("call_forward without an AI target terminates", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("F", "Transfer", "call_forward", null),
        terminalNode("E", "End", "end_conversation", "Done"),
      ],
      edges: [edge("S", "A", "http"), edge("A", "F", "int-X"), edge("F", "E", "completed")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    const e = asTerminal(plan["X"]);
    expect(e.type).toBe("end_conversation");
    expect((e as Dict)["node_uuid"]).toBeUndefined();
  });

  test("missing edge omits the intent", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [
          { id: "int-X", intent_name: "X" },
          { id: "int-Y", intent_name: "Y" },
        ]),
        aiNode("B", "NodeB", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "B", "int-X")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    expect(plan["X"]).toBeDefined();
    expect(plan["Y"]).toBeUndefined();
  });

  test("world_state lookup prefers node id over config name", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("H", "HttpN", "http_request", null),
        aiNode("B", "NodeB", null),
        aiNode("C", "NodeC", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "H", "int-X"), edge("H", "B", "success"), edge("H", "C", "failure")],
    };
    const ws: Record<string, WorldStateEntry> = {
      H: { outcome: "failure", data: {} },
      HttpN: { outcome: "success", data: {} },
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), ws, null);
    expect(asAi(plan["X"]).node_uuid).toBe("C"); // node id wins
  });

  test("hop cap protects against cycles", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("H1", "Http1", "http_request", null),
        mockNode("H2", "Http2", "http_request", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "H1", "int-X"), edge("H1", "H2", "success"), edge("H2", "H1", "success")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    expect(plan["X"]).toBeUndefined();
  });

  test("collects nodeVars along the walk (under the AI node id)", () => {
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        mockNode("H", "HttpN", "http_request", null),
        aiNode("B", "NodeB", null),
      ],
      edges: [
        edge("S", "A", "http"),
        edge("A", "H", "int-X", { nodeVars: ["{{NodeA.foo}}"] }),
        edge("H", "B", "success", { nodeVars: ["{{HttpN.bar}}"] }),
      ],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    // Both the start edge (AI source) and the http→B edge (AI source) collect under "A".
    expect(asAi(plan["X"]).template_vars["A"]).toEqual(["foo", "bar"]);
  });

  test("walks prompt_completed edges", () => {
    const flow = {
      nodes: [startNode("S"), aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]), promptNode("P", "Prompt"), aiNode("B", "NodeB", null)],
      edges: [edge("S", "A", "http"), edge("A", "P", "int-X"), edge("P", "B", "prompt_completed")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null);
    expect(asAi(plan["X"]).node_uuid).toBe("B");
  });

  test("renders end_message via the variable store", () => {
    const store = new VariableStore();
    store.set("EndN", "end-id", { ticket: "T-42" });
    const flow = {
      nodes: [
        startNode("S"),
        aiNode("A", "NodeA", [{ id: "int-X", intent_name: "X" }]),
        terminalNode("E", "EndN", "end_conversation", "Bye, ref {{EndN.ticket}}"),
      ],
      edges: [edge("S", "A", "http"), edge("A", "E", "int-X")],
    };
    const plan = computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, store);
    expect(asTerminal(plan["X"]).end_message).toBe("Bye, ref T-42");
  });

  test("non-AI current node and missing intents array yield an empty plan", () => {
    const flow = {
      nodes: [startNode("S"), aiNode("A", "NoIntents", null), mockNode("H", "HttpN", "http_request", null)],
      edges: [edge("S", "H", "http")],
    };
    // current node is a control node → empty.
    expect(computeHandoffPlan(nodeOf(flow, "H"), graphFrom(flow), null, null)).toEqual({});
    // AI node with empty intents → empty.
    expect(computeHandoffPlan(nodeOf(flow, "A"), graphFrom(flow), null, null)).toEqual({});
  });
});

describe("VariableStore — {{Node.var}} rendering (port of variable_renderer.go)", () => {
  test("resolves {{NodeName.var}} by config name and by node id", () => {
    const store = new VariableStore();
    store.set("Greeting", "node-1", { city: "Boston" });
    expect(store.render("You are in {{Greeting.city}}.")).toBe("You are in Boston.");
    expect(store.render("You are in {{node-1.city}}.")).toBe("You are in Boston.");
  });

  test("leaves unknown references untouched", () => {
    const store = new VariableStore();
    store.set("Greeting", "node-1", { city: "Boston" });
    expect(store.render("Hi {{Unknown.var}} and {{Greeting.missing}}.")).toBe("Hi {{Unknown.var}} and {{Greeting.missing}}.");
  });

  test("second pass resolves bare {{var}} across nodes", () => {
    const store = new VariableStore();
    store.set("NodeA", "a", { order_id: "OID-9" });
    expect(store.render("Order {{order_id}} confirmed.")).toBe("Order OID-9 confirmed.");
  });

  test("Go %v stringification: number bare, bool, null, nested", () => {
    const store = new VariableStore();
    store.set("N", "n", { count: 7, ok: true, missing: null, meta: { b: 2, a: 1 }, items: ["x", "y"] });
    expect(store.render("{{N.count}}")).toBe("7");
    expect(store.render("{{N.ok}}")).toBe("true");
    expect(store.render("{{N.missing}}")).toBe("<nil>");
    expect(store.render("{{N.meta}}")).toBe("map[a:1 b:2]"); // keys sorted
    expect(store.render("{{N.items}}")).toBe("[x y]");
  });

  test("set is a no-op for empty variables (no phantom inner map)", () => {
    const store = new VariableStore();
    store.set("Empty", "e", {});
    expect(store.get("Empty", "anything").ok).toBe(false);
    expect(store.flattenToStringMap()).toEqual({});
  });

  test("flattenToStringMap keys are NodeName.varName from the name index only", () => {
    const store = new VariableStore();
    store.set("NodeA", "a", { x: 1, y: "z" });
    expect(store.flattenToStringMap()).toEqual({ "NodeA.x": "1", "NodeA.y": "z" });
  });
});

describe("buildAgentConfig — field-for-field (port of buildAgentConfig)", () => {
  function node(config: Dict): AgentConfigNode {
    return { id: "n1", type: "ai_agent_v2", config, configName: String(config["name"] ?? "n1") };
  }

  test("deep-copies node config and does NOT mutate the source", () => {
    const store = new VariableStore();
    const src = { name: "Agent", instructions: "Hello", nested: { a: 1 } };
    const out = buildAgentConfig(node(src), store, null);
    out["instructions"] = "MUTATED";
    (out["nested"] as Dict)["a"] = 999;
    expect(src.instructions).toBe("Hello"); // unchanged
    expect(src.nested.a).toBe(1); // deep copy isolated nested objects
  });

  test("renders {{Node.var}} in instructions against the store", () => {
    const store = new VariableStore();
    store.set("Lookup", "lk", { name: "Sam" });
    const out = buildAgentConfig(node({ name: "Agent", instructions: "Hi {{Lookup.name}}." }), store, null);
    expect(out["instructions"]).toBe("Hi Sam.");
  });

  test("hoists global_prompt / voice_config / stt_guidance from flowConfig", () => {
    const store = new VariableStore();
    const flowConfig = {
      systemPrompt: { prompt: "Be helpful." },
      agentSettings: { voice_ai_config: { lang: "en" } },
      global_meta: { stt_guidance: "Domain terms: refund, RMA." },
    };
    const out = buildAgentConfig(node({ name: "Agent" }), store, flowConfig);
    expect(out["global_prompt"]).toBe("Be helpful.");
    expect(out["voice_config"]).toEqual({ lang: "en" });
    expect(out["stt_guidance"]).toBe("Domain terms: refund, RMA.");
  });

  test("omits stt_guidance when empty; omits hoisted keys when flow sections absent", () => {
    const store = new VariableStore();
    const out = buildAgentConfig(node({ name: "Agent" }), store, { global_meta: { stt_guidance: "" } });
    expect(out["stt_guidance"]).toBeUndefined();
    expect(out["global_prompt"]).toBeUndefined();
    expect(out["voice_config"]).toBeUndefined();
  });

  test("always sets all_node_vars and defaults variables to []", () => {
    const store = new VariableStore();
    store.set("NodeA", "a", { x: 1 });
    const out = buildAgentConfig(node({ name: "Agent" }), store, null);
    expect(out["all_node_vars"]).toEqual({ "NodeA.x": "1" });
    expect(out["variables"]).toEqual([]);
  });

  test("preserves an existing variables array (does not clobber)", () => {
    const store = new VariableStore();
    const out = buildAgentConfig(node({ name: "Agent", variables: [{ variable_name: "order_id" }] }), store, null);
    expect(out["variables"]).toEqual([{ variable_name: "order_id" }]);
  });

  test("KNOWN GAP: flow-level agentSettings.knowledge_base_ids is NOT hoisted (parity)", () => {
    const store = new VariableStore();
    const flowConfig = { agentSettings: { knowledge_base_ids: ["kb-1", "kb-2"], voice_ai_config: { lang: "en" } } };
    const out = buildAgentConfig(node({ name: "Agent" }), store, flowConfig);
    // The worker's buildAgentConfig drops the flow-level KB list — we mirror that gap.
    expect(out["knowledge_base_ids"]).toBeUndefined();
    // ...but a KB list already on the NODE config survives the deep copy.
    const out2 = buildAgentConfig(node({ name: "Agent", knowledge_base_ids: ["node-kb"] }), store, flowConfig);
    expect(out2["knowledge_base_ids"]).toEqual(["node-kb"]);
  });
});

describe("buildAgentTasksAgentConfig — agent_node flow-session config (SER-6078)", () => {
  function agentNode(config: Dict): AgentConfigNode {
    return { id: "an1", type: "agent_node", config, configName: String(config["name"] ?? "an1") };
  }

  function sourceConfig(): Dict {
    return {
      name: "Confirm Delivery Details",
      channel: "call",
      instructions: "Confirm details for {{Start.contact_name}}.",
      initial_wait_time: 5,
      intents: [{ id: "done-uuid", intent_name: "Done" }],
      agent_tasks: {
        variables: [
          {
            name: "address_confirmation",
            type: "text",
            instructions: "Confirm the address for {{Start.contact_name}}.",
            known_value: "{{Start.street_address}}",
            confirm_if_known: true,
          },
          { name: "backup_phone", type: "phone", instructions: "Ask for a backup number." },
        ],
        extract_only: [{ name: "notes", instructions: "Note anything about {{Start.contact_name}}." }],
        confirm_announcement: "I have your details from {{Start.street_address}} on file.",
      },
    };
  }

  function storeWithStart(): VariableStore {
    const store = new VariableStore();
    store.set("Start", "start-1", { contact_name: "Jordan Lee", street_address: "1468 Cedar Ave" });
    return store;
  }

  test("renders known_value, task instructions, and confirm_announcement against the store", () => {
    const out = buildAgentTasksAgentConfig(agentNode(sourceConfig()), storeWithStart(), null);
    const tasks = out["agent_tasks"] as Dict;
    const variables = tasks["variables"] as Dict[];
    expect(variables[0]!["known_value"]).toBe("1468 Cedar Ave");
    expect(variables[0]!["instructions"]).toBe("Confirm the address for Jordan Lee.");
    expect((tasks["extract_only"] as Dict[])[0]!["instructions"]).toBe("Note anything about Jordan Lee.");
    expect(tasks["confirm_announcement"]).toBe("I have your details from 1468 Cedar Ave on file.");
    expect(out["instructions"]).toBe("Confirm details for Jordan Lee.");
  });

  test("forces initial_wait_time to 0 (text sim has no call-start audio)", () => {
    const out = buildAgentTasksAgentConfig(agentNode(sourceConfig()), storeWithStart(), null);
    expect(out["initial_wait_time"]).toBe(0);
  });

  test("does NOT mutate the source node config", () => {
    const src = sourceConfig();
    buildAgentTasksAgentConfig(agentNode(src), storeWithStart(), null);
    const srcTasks = src["agent_tasks"] as Dict;
    expect((srcTasks["variables"] as Dict[])[0]!["known_value"]).toBe("{{Start.street_address}}");
    expect(srcTasks["confirm_announcement"]).toBe("I have your details from {{Start.street_address}} on file.");
    expect(src["initial_wait_time"]).toBe(5);
  });

  test("unresolvable refs and absent fields pass through untouched", () => {
    const config = sourceConfig();
    ((config["agent_tasks"] as Dict)["variables"] as Dict[])[1]!["known_value"] = "{{Start.missing_param}}";
    const out = buildAgentTasksAgentConfig(agentNode(config), storeWithStart(), null);
    const variables = (out["agent_tasks"] as Dict)["variables"] as Dict[];
    expect(variables[1]!["known_value"]).toBe("{{Start.missing_param}}");
  });
});
