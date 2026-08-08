// AO Simulation Engine — FlowGraph executor + EdgeResolver parity tests.
//
// PURE: no Redis/DB/HTTP. Mirrors the worker's `flow_orchestrator_test.go`
// and `edge_resolver_test.go` fixtures + expected outcomes, with a FAKE
// AINodeExecutor returning canned intents. The traversed node path + final
// StopReason are asserted against the worker's expected results so the port
// is provably faithful.

import { describe, test, expect } from "bun:test";
import { parseFlowGraph, FlowOrchestrator } from "../src/sim-engine/run-engine/flow-executor.js";
import { EdgeResolver, resolveIntentSourceHandle } from "../src/sim-engine/run-engine/edge-resolver.js";
import type {
  AINodeExecutor,
  FlowGraph,
  FlowNode,
  NodeExecutionResult,
  VariableStore,
  WorldStateEntry,
} from "../src/sim-engine/run-engine/flow-types.js";

// --- Fixture builders (mirror the Go test helpers in handoff_planner_test.go) ---

type RawNode = Record<string, unknown>;
type RawEdge = Record<string, unknown>;

function startNode(id: string): RawNode {
  return { id, type: "start", data: { config: { name: "Start" } } };
}

function aiNode(id: string, name: string, intents: Record<string, unknown>[] | null): RawNode {
  return { id, type: "ai_agent_v2", data: { config: { name, intents: intents ?? [] } } };
}

function mockNode(id: string, name: string, nodeType: string, intents: Record<string, unknown>[] | null): RawNode {
  return { id, type: nodeType, data: { config: { name, intents: intents ?? [] } } };
}

function terminalNode(id: string, name: string, nodeType: string, endMessage: string): RawNode {
  return { id, type: nodeType, data: { config: { name, end_message: endMessage } } };
}

function promptNode(id: string, name: string): RawNode {
  return { id, type: "prompt", data: { config: { name } } };
}

function edge(source: string, target: string, handle: string): RawEdge {
  return { id: `${source}-${target}`, source, target, sourceHandle: handle };
}

function parseGraph(flow: { nodes: RawNode[]; edges: RawEdge[] }): FlowGraph {
  return parseFlowGraph(JSON.stringify(flow));
}

// A fake executor returning a single canned result for every ai_agent_v2 turn
// (mirrors the Go `staticAINodeExecutor`).
function staticAIExecutor(result: NodeExecutionResult | null): AINodeExecutor {
  return {
    async executeAINode(_node: FlowNode, _turnIndex: number, _store: VariableStore) {
      return result;
    },
  };
}

function aiResult(outcome: string): NodeExecutionResult {
  return { outcome, variables: {}, message: "" };
}

// --- Orchestrator parity (flow_orchestrator_test.go) ---

describe("FlowOrchestrator.run — worker parity", () => {
  test("ai_action entry without outcome uses default intent (first intent id)", async () => {
    // Mirrors TestFlowOrchestrator_AiActionEntryWithoutOutcomeUsesDefaultIntent.
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        mockNode("P", "Prompt", "prompt", null),
        mockNode("AC", "ActionN", "ai_action", [{ id: "act-success-uuid", intent_name: "Action Succeeded" }]),
        terminalNode("E", "End", "end_conversation", "Done"),
      ],
      edges: [edge("S", "P", "http"), edge("P", "AC", "prompt_completed"), edge("AC", "E", "act-success-uuid")],
    });
    // world_state entry exists for AC but carries no outcome → defaultMockedOutcome → first intent id.
    const worldState = new Map<string, WorldStateEntry>([["AC", { actionMocks: { tool: { ok: true } } }]]);

    const result = await new FlowOrchestrator(graph, worldState, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.last_node_id).toBe("E");
    // start (http) → prompt (prompt_completed) → ai_action (default intent uuid) → end.
    expect(result.nodes_visited).toEqual(["S", "P", "AC", "E"]);
    expect(result.turn_count).toBe(0); // ai_action is not a conversational turn.
  });

  test("call_forward with world_state no_answer routes to the AI node", async () => {
    // Mirrors TestFlowOrchestrator_CallForwardWithWorldStateRoutesToAINode.
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        mockNode("F", "Transfer", "call_forward", null),
        aiNode("A", "Handle Failed Transfer", [{ id: "scheduled-uuid", intent_name: "Callback Scheduled" }]),
        terminalNode("E", "End", "end_conversation", "Done"),
      ],
      edges: [
        edge("S", "F", "http"),
        edge("F", "E", "completed"),
        edge("F", "A", "no_answer"),
        edge("A", "E", "scheduled-uuid"),
      ],
    });
    const worldState = new Map<string, WorldStateEntry>([["F", { outcome: "no_answer" }]]);

    const result = await new FlowOrchestrator(
      graph,
      worldState,
      10,
      staticAIExecutor(aiResult("Callback Scheduled")),
    ).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(1); // one AI turn after the call_forward no_answer branch.
    expect(result.last_node_id).toBe("E");
    expect(result.nodes_visited).toEqual(["S", "F", "A", "E"]);
  });

  test("call_forward without an AI target terminates at the call_forward node", async () => {
    // Mirrors TestFlowOrchestrator_CallForwardWithoutAITargetTerminates.
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        mockNode("F", "Transfer", "call_forward", null),
        terminalNode("E", "End", "end_conversation", "Done"),
      ],
      edges: [edge("S", "F", "http"), edge("F", "E", "completed")],
    });

    const result = await new FlowOrchestrator(graph, null, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.last_node_id).toBe("F"); // terminates AT the call_forward, not the end node.
    expect(result.turn_count).toBe(0);
    expect(result.nodes_visited).toEqual(["S", "F"]);
  });

  test("call_forward completed (mixed edges) terminates at the call_forward node", async () => {
    // Mirrors TestFlowOrchestrator_CallForwardCompletedWithMixedEdgesTerminates.
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        mockNode("F", "Transfer", "call_forward", null),
        terminalNode("E", "End", "end_conversation", "Done"),
        aiNode("A", "Handle Failed Transfer", [{ id: "scheduled-uuid", intent_name: "Callback Scheduled" }]),
      ],
      edges: [
        edge("S", "F", "http"),
        edge("F", "E", "completed"),
        edge("F", "A", "no_answer"),
        edge("A", "E", "scheduled-uuid"),
      ],
    });

    // No world_state → call_forward defaults to "completed" → routes to end (not AI) → terminate at F.
    const result = await new FlowOrchestrator(graph, null, 10, staticAIExecutor(aiResult("Callback Scheduled"))).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.last_node_id).toBe("F");
    expect(result.turn_count).toBe(0);
    expect(result.nodes_visited).toEqual(["S", "F"]);
  });
});

// --- ai_agent_v2 traversal + termination conditions ---

describe("FlowOrchestrator.run — ai_agent_v2 behavior", () => {
  test("start → ai_agent_v2 → end_conversation, intent resolves via UUID", async () => {
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        aiNode("A", "Greet", [{ id: "int-X", intent_name: "wants_refund" }]),
        terminalNode("E", "End", "end_conversation", "Bye"),
      ],
      edges: [edge("S", "A", "http"), edge("A", "E", "int-X")],
    });

    const result = await new FlowOrchestrator(graph, null, 10, staticAIExecutor(aiResult("wants_refund"))).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.nodes_visited).toEqual(["S", "A", "E"]);
    expect(result.last_node_id).toBe("E");
    expect(result.last_node_type).toBe("end_conversation");
    expect(result.turn_count).toBe(1);
  });

  test("empty intent stays on the same node until max_turns is exceeded", async () => {
    const graph = parseGraph({
      nodes: [startNode("S"), aiNode("A", "Greet", [{ id: "int-X", intent_name: "done" }])],
      edges: [edge("S", "A", "http")],
    });

    // Executor always returns an empty outcome → re-enters A each turn → max_turns (3) trips.
    const result = await new FlowOrchestrator(graph, null, 3, staticAIExecutor(aiResult(""))).run();

    expect(result.stop_reason).toBe("max_turns");
    expect(result.last_node_id).toBe("A");
    expect(result.turn_count).toBe(4); // turnCount increments to maxTurns+1 before the guard fires.
    // S visited once; A pushed each loop entry (3 staying turns + the 4th that trips the cap).
    expect(result.nodes_visited).toEqual(["S", "A", "A", "A", "A"]);
  });

  test("unknown intent (no matching intent) stops with unknown_intent", async () => {
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        aiNode("A", "Greet", [{ id: "int-X", intent_name: "wants_refund" }]),
        terminalNode("E", "End", "end_conversation", "Bye"),
      ],
      edges: [edge("S", "A", "http"), edge("A", "E", "int-X")],
    });

    const result = await new FlowOrchestrator(graph, null, 10, staticAIExecutor(aiResult("nonexistent_intent"))).run();

    expect(result.stop_reason).toBe("unknown_intent");
    expect(result.error_detail).toBe("nonexistent_intent");
    expect(result.last_node_id).toBe("A");
    expect(result.nodes_visited).toEqual(["S", "A"]);
  });

  test("matched intent with no outgoing edge stops with no_matching_edge", async () => {
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        aiNode("A", "Greet", [{ id: "int-X", intent_name: "wants_refund" }]),
        terminalNode("E", "End", "end_conversation", "Bye"),
      ],
      // No edge for handle int-X out of A.
      edges: [edge("S", "A", "http")],
    });

    const result = await new FlowOrchestrator(graph, null, 10, staticAIExecutor(aiResult("wants_refund"))).run();

    expect(result.stop_reason).toBe("no_matching_edge");
    expect(result.error_detail).toBe("int-X"); // detail is the unmatched sourceHandle.
    expect(result.last_node_id).toBe("A");
  });

  test("unsupported node type stops with unsupported_node_type", async () => {
    const graph = parseGraph({
      nodes: [startNode("S"), mockNode("Z", "Mystery", "some_unknown_type", null)],
      edges: [edge("S", "Z", "http")],
    });

    const result = await new FlowOrchestrator(graph, null, 10, null).run();

    expect(result.stop_reason).toBe("unsupported_node_type");
    expect(result.error_detail).toBe("some_unknown_type");
    expect(result.last_node_id).toBe("Z");
  });
});

// --- ParseFlowGraph edge cases ---

describe("parseFlowGraph", () => {
  test("throws on invalid JSON", () => {
    expect(() => parseFlowGraph("{not json")).toThrow(/invalid flow JSON/);
  });

  test("throws when 'nodes' array is missing", () => {
    expect(() => parseFlowGraph(JSON.stringify({ edges: [] }))).toThrow(/missing 'nodes' array/);
  });

  test("throws when there is no start node", () => {
    expect(() =>
      parseFlowGraph(JSON.stringify({ nodes: [aiNode("A", "Greet", null)], edges: [] })),
    ).toThrow(/no start node/);
  });

  test("captures config name, edges, and start node id", () => {
    const graph = parseGraph({
      nodes: [startNode("S"), aiNode("A", "Greet", null)],
      edges: [edge("S", "A", "http")],
    });
    expect(graph.startNodeId).toBe("S");
    expect(graph.nodes.get("A")?.configName).toBe("Greet");
    expect(graph.nodeEdges.get("S")).toHaveLength(1);
    expect(graph.nodeEdges.get("S")?.[0]?.sourceHandle).toBe("http");
  });
});

// --- EdgeResolver direct unit tests (edge_resolver_test.go) ---

describe("EdgeResolver.resolveNextNode", () => {
  test("intent name → next node (resolves to the intent UUID edge)", () => {
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        aiNode("A", "Agent", [{ id: "int-X", intent_name: "wants_refund" }]),
        aiNode("B", "Next", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "B", "int-X")],
    });

    const res = new EdgeResolver(graph).resolveNextNode("A", aiResult("wants_refund"));

    expect(res.stopReason).toBe("");
    expect(res.errorDetail).toBe("");
    expect(res.nextNodeId).toBe("B");
  });

  test("intent UUID returned directly by the LLM resolves to the same edge", () => {
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        aiNode("A", "Agent", [{ id: "int-X", intent_name: "wants_refund" }]),
        aiNode("B", "Next", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "B", "int-X")],
    });

    // The LLM returned the UUID ("int-X") instead of the intent name.
    const res = new EdgeResolver(graph).resolveNextNode("A", aiResult("int-X"));

    expect(res.stopReason).toBe("");
    expect(res.nextNodeId).toBe("B");
  });

  test("no matching intent → unknown_intent (detail carries the unknown name)", () => {
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        aiNode("A", "Agent", [{ id: "int-X", intent_name: "wants_refund" }]),
        aiNode("B", "Next", null),
      ],
      edges: [edge("S", "A", "http"), edge("A", "B", "int-X")],
    });

    const res = new EdgeResolver(graph).resolveNextNode("A", aiResult("nope"));

    expect(res.nextNodeId).toBe("");
    expect(res.stopReason).toBe("unknown_intent");
    expect(res.errorDetail).toBe("nope");
  });

  test("ai_action falls back to outcome handle when no intent matches", () => {
    // resolveIntentSourceHandle misses → sourceHandle = outcome ("failure").
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        mockNode("AC", "Action", "ai_action", [{ id: "act-ok", intent_name: "success" }]),
        aiNode("B", "Next", null),
      ],
      edges: [edge("S", "AC", "http"), edge("AC", "B", "failure")],
    });

    const res = new EdgeResolver(graph).resolveNextNode("AC", aiResult("failure"));

    expect(res.stopReason).toBe("");
    expect(res.nextNodeId).toBe("B");
  });

  test("prompt prefers prompt_completed over success", () => {
    // Mirrors TestEdgeResolver_PromptPrefersPromptCompleted.
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        promptNode("P", "Prompt"),
        aiNode("Legacy", "Legacy Agent", null),
        aiNode("Current", "Current Agent", null),
      ],
      edges: [edge("S", "P", "http"), edge("P", "Legacy", "success"), edge("P", "Current", "prompt_completed")],
    });

    const res = new EdgeResolver(graph).resolveNextNode("P", aiResult("success"));

    expect(res.stopReason).toBe("");
    expect(res.nextNodeId).toBe("Current");
  });

  test("prompt falls back to success when prompt_completed is absent", () => {
    // Mirrors TestEdgeResolver_PromptFallsBackToSuccess.
    const graph = parseGraph({
      nodes: [startNode("S"), promptNode("P", "Prompt"), aiNode("A", "Agent", null)],
      edges: [edge("S", "P", "http"), edge("P", "A", "success")],
    });

    const res = new EdgeResolver(graph).resolveNextNode("P", aiResult("success"));

    expect(res.stopReason).toBe("");
    expect(res.nextNodeId).toBe("A");
  });

  test("prompt with no usable edge → no_matching_edge (empty detail)", () => {
    // Mirrors TestEdgeResolver_PromptNoMatchingEdge.
    const graph = parseGraph({
      nodes: [startNode("S"), promptNode("P", "Prompt"), aiNode("A", "Agent", null)],
      edges: [edge("S", "P", "http"), edge("P", "A", "other")],
    });

    const res = new EdgeResolver(graph).resolveNextNode("P", aiResult("success"));

    expect(res.nextNodeId).toBe("");
    expect(res.stopReason).toBe("no_matching_edge");
    expect(res.errorDetail).toBe(""); // prompt's no-match path carries no detail.
  });

  test("missing node → error", () => {
    const graph = parseGraph({ nodes: [startNode("S")], edges: [] });
    const res = new EdgeResolver(graph).resolveNextNode("ghost", aiResult("x"));
    expect(res.stopReason).toBe("error");
    expect(res.errorDetail).toBe("node not found: ghost");
  });
});

// --- resolveIntentSourceHandle direct unit tests ---

describe("resolveIntentSourceHandle", () => {
  const node: FlowNode = {
    id: "A",
    type: "ai_agent_v2",
    configName: "Agent",
    metaName: "",
    config: { intents: [{ id: "uuid-1", intent_name: "refund" }] },
    data: null,
  };

  test("matches by intent_name → returns uuid", () => {
    expect(resolveIntentSourceHandle(node, "refund")).toEqual(["uuid-1", true]);
  });

  test("matches by uuid directly → returns uuid", () => {
    expect(resolveIntentSourceHandle(node, "uuid-1")).toEqual(["uuid-1", true]);
  });

  test("no match → [\"\", false]", () => {
    expect(resolveIntentSourceHandle(node, "unknown")).toEqual(["", false]);
  });
});

// --- contact_screening (SER-6070): mocked multi-outcome node. Dispositions are
// LITERAL edge sourceHandles (reached/wrong_contact/... and "Voicemail
// Detected"), matching phlo-core's output states — no intent-UUID indirection.
describe("contact_screening", () => {
  function screeningGraph(): FlowGraph {
    return parseGraph({
      nodes: [
        startNode("S"),
        mockNode("IC", "Dial", "initiate_call", null),
        mockNode("SC", "Screen Contact", "contact_screening", null),
        aiNode("A", "Reminder Conversation", [{ id: "done-uuid", intent_name: "Done" }]),
        terminalNode("E", "End", "end_conversation", "Bye"),
        terminalNode("VM", "Voicemail Close", "end_conversation", "VM bye"),
      ],
      edges: [
        edge("S", "IC", "http"),
        edge("IC", "SC", "answered"),
        edge("SC", "A", "reached"),
        edge("SC", "VM", "Voicemail Detected"),
        edge("SC", "E", "wrong_contact"),
        edge("A", "E", "done-uuid"),
      ],
    });
  }

  test("world_state disposition routes on the literal handle and records node_vars", async () => {
    const worldState = new Map<string, WorldStateEntry>([
      [
        "SC",
        {
          outcome: "reached",
          data: {
            screening_disposition: "reached",
            screening_status: "completed",
            screening_answered_by: "Morgan Patel",
            screening_relationship: "self",
            screening_callback_time: "",
          },
        },
      ],
    ]);

    const result = await new FlowOrchestrator(
      screeningGraph(),
      worldState,
      10,
      staticAIExecutor(aiResult("Done")),
    ).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(1);
    expect(result.nodes_visited).toEqual(["S", "IC", "SC", "A", "E"]);
  });

  test("Voicemail Detected routes to the voicemail terminal with zero AI turns", async () => {
    const worldState = new Map<string, WorldStateEntry>([["SC", { outcome: "Voicemail Detected" }]]);

    const result = await new FlowOrchestrator(screeningGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(0);
    expect(result.last_node_id).toBe("VM");
    expect(result.nodes_visited).toEqual(["S", "IC", "SC", "VM"]);
  });

  test("the voicemail disposition VALUE aliases to the Voicemail Detected edge key", async () => {
    const worldState = new Map<string, WorldStateEntry>([["SC", { outcome: "voicemail" }]]);

    const result = await new FlowOrchestrator(screeningGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.last_node_id).toBe("VM");
    expect(result.nodes_visited).toEqual(["S", "IC", "SC", "VM"]);
  });

  test("no world_state entry and no executor falls back to the reached mock", async () => {
    // SC routes straight to a terminal so the executor-less run never touches
    // an ai_agent_v2 (which would be a contract violation and throw).
    const graph = parseGraph({
      nodes: [
        startNode("S"),
        mockNode("IC", "Dial", "initiate_call", null),
        mockNode("SC", "Screen Contact", "contact_screening", null),
        terminalNode("E", "End", "end_conversation", "Bye"),
      ],
      edges: [edge("S", "IC", "http"), edge("IC", "SC", "answered"), edge("SC", "E", "reached")],
    });

    const result = await new FlowOrchestrator(graph, null, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(0);
    expect(result.nodes_visited).toEqual(["S", "IC", "SC", "E"]);
  });

  test("unpinned screening runs conversationally through the AI executor (SER-6070)", async () => {
    const executor = {
      async executeAINode(node: FlowNode): Promise<NodeExecutionResult | null> {
        return node.type === "contact_screening" ? aiResult("reached") : aiResult("Done");
      },
    };
    const result = await new FlowOrchestrator(screeningGraph(), null, 10, executor).run();

    expect(result.stop_reason).toBe("end_conversation");
    // Both the screening conversation and the downstream ai_agent_v2 count turns.
    expect(result.turn_count).toBe(2);
    expect(result.nodes_visited).toEqual(["S", "IC", "SC", "A", "E"]);
  });

  test("pinned screening never calls the AI executor", async () => {
    const throwing = {
      async executeAINode(node: FlowNode): Promise<NodeExecutionResult | null> {
        if (node.type !== "ai_agent_v2") throw new Error("executor called for pinned screening");
        return aiResult("Done");
      },
    };
    const worldState = new Map<string, WorldStateEntry>([["SC", { outcome: "wrong_contact" }]]);

    const result = await new FlowOrchestrator(screeningGraph(), worldState, 10, throwing).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.last_node_id).toBe("E");
    expect(result.nodes_visited).toEqual(["S", "IC", "SC", "E"]);
  });

  test("screening conversation turns count toward max_turns", async () => {
    // Executor always returns empty outcome = stay on the screening node forever.
    const result = await new FlowOrchestrator(
      screeningGraph(),
      null,
      3,
      staticAIExecutor(aiResult("")),
    ).run();

    expect(result.stop_reason).toBe("max_turns");
    expect(result.turn_count).toBe(4);
  });

  test("unwired disposition stops with no_matching_edge", async () => {
    const worldState = new Map<string, WorldStateEntry>([["SC", { outcome: "do_not_call" }]]);

    const result = await new FlowOrchestrator(screeningGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("no_matching_edge");
    expect(result.error_detail).toBe("do_not_call");
  });
});

// The builder-canvas composite: dial + screening in ONE node, carrying the
// disposition handles AND the carrier handles. The sim receives the canvas
// shape (console sends flowInstance.getNodes() verbatim), so the composite
// must execute exactly like the standalone screening node.
describe("outbound_screening composite", () => {
  function compositeGraph(): FlowGraph {
    return parseGraph({
      nodes: [
        startNode("S"),
        mockNode("OS", "Call and Screen", "outbound_screening", null),
        aiNode("A", "Reminder Conversation", [{ id: "done-uuid", intent_name: "Done" }]),
        terminalNode("E", "End", "end_conversation", "Bye"),
        terminalNode("VM", "Voicemail Close", "end_conversation", "VM bye"),
        terminalNode("NA", "No Answer Close", "end_conversation", "NA bye"),
      ],
      edges: [
        edge("S", "OS", "http"),
        edge("OS", "A", "reached"),
        edge("OS", "VM", "Voicemail Detected"),
        edge("OS", "NA", "no_answer"),
        edge("A", "E", "done-uuid"),
      ],
    });
  }

  test("unpinned composite runs conversationally; executor disposition routes it", async () => {
    const executor = {
      async executeAINode(node: FlowNode): Promise<NodeExecutionResult | null> {
        return node.type === "outbound_screening" ? aiResult("reached") : aiResult("Done");
      },
    };
    const result = await new FlowOrchestrator(compositeGraph(), null, 10, executor).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(2);
    expect(result.nodes_visited).toEqual(["S", "OS", "A", "E"]);
  });

  test("carrier handle no_answer routes from the composite", async () => {
    const worldState = new Map<string, WorldStateEntry>([["OS", { outcome: "no_answer" }]]);

    const result = await new FlowOrchestrator(compositeGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(0);
    expect(result.last_node_id).toBe("NA");
  });

  test("voicemail value aliases to the edge key on the composite too", async () => {
    const worldState = new Map<string, WorldStateEntry>([["OS", { outcome: "voicemail" }]]);

    const result = await new FlowOrchestrator(compositeGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.last_node_id).toBe("VM");
  });
});

// --- agent_node (SER-6078): the agent_tasks walk runs as a livekit flow-session
// (conversational, same executor contract as ai_agent_v2/unpinned screening).
// Exits through node-level intents; edges use intent-UUID sourceHandles like
// ai_agent_v2. A world_state outcome pins the deterministic mock instead.
describe("agent_node", () => {
  function agentNodeGraph(): FlowGraph {
    return parseGraph({
      nodes: [
        startNode("S"),
        mockNode("OS", "Delivery Screening", "outbound_screening", null),
        mockNode("AN", "Confirm Delivery Details", "agent_node", [
          { id: "confirmed-uuid", intent_name: "Delivery Confirmed" },
          { id: "callback-uuid", intent_name: "Callback Requested" },
        ]),
        terminalNode("E", "Confirmed End", "end_conversation", "Bye"),
        terminalNode("CB", "Callback End", "end_conversation", "Later"),
      ],
      edges: [
        edge("S", "OS", "http"),
        edge("OS", "AN", "reached"),
        edge("AN", "E", "confirmed-uuid"),
        edge("AN", "CB", "callback-uuid"),
      ],
    });
  }

  test("conversational exit intent resolves through the intent-UUID edge", async () => {
    // Screening pinned so the static executor's canned intent only reaches
    // the agent_node turn (screening resolves on literal handles, not intents).
    const worldState = new Map<string, WorldStateEntry>([["OS", { outcome: "reached" }]]);

    const result = await new FlowOrchestrator(
      agentNodeGraph(),
      worldState,
      10,
      staticAIExecutor(aiResult("Delivery Confirmed")),
    ).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(1);
    expect(result.last_node_id).toBe("E");
    expect(result.nodes_visited).toEqual(["S", "OS", "AN", "E"]);
  });

  test("world_state pins the intent and skips the conversation", async () => {
    const worldState = new Map<string, WorldStateEntry>([
      ["OS", { outcome: "reached" }],
      ["AN", { outcome: "Callback Requested", data: { backup_phone_number: "+12025550141" } }],
    ]);

    const result = await new FlowOrchestrator(agentNodeGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(0);
    expect(result.last_node_id).toBe("CB");
    expect(result.nodes_visited).toEqual(["S", "OS", "AN", "CB"]);
  });

  test("no executor and no pin falls back to the first-intent mock default", async () => {
    const worldState = new Map<string, WorldStateEntry>([["OS", { outcome: "reached" }]]);

    const result = await new FlowOrchestrator(agentNodeGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.turn_count).toBe(0);
    expect(result.last_node_id).toBe("E");
  });

  test("unknown exit intent stops with unknown_intent", async () => {
    const worldState = new Map<string, WorldStateEntry>([["OS", { outcome: "reached" }]]);

    const result = await new FlowOrchestrator(
      agentNodeGraph(),
      worldState,
      10,
      staticAIExecutor(aiResult("Not An Intent")),
    ).run();

    expect(result.stop_reason).toBe("unknown_intent");
    expect(result.error_detail).toBe("Not An Intent");
  });

  test("exit intent returned as a UUID resolves directly", () => {
    const graph = agentNodeGraph();
    const resolver = new EdgeResolver(graph);
    const resolved = resolver.resolveNextNode("AN", { outcome: "callback-uuid", variables: {}, message: "" });
    expect(resolved.stopReason).toBe("");
    expect(resolved.nextNodeId).toBe("CB");
  });
});
