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

  test("no world_state entry defaults to the reached disposition", async () => {
    const result = await new FlowOrchestrator(
      screeningGraph(),
      null,
      10,
      staticAIExecutor(aiResult("Done")),
    ).run();

    expect(result.stop_reason).toBe("end_conversation");
    expect(result.nodes_visited).toEqual(["S", "IC", "SC", "A", "E"]);
  });

  test("unwired disposition stops with no_matching_edge", async () => {
    const worldState = new Map<string, WorldStateEntry>([["SC", { outcome: "do_not_call" }]]);

    const result = await new FlowOrchestrator(screeningGraph(), worldState, 10, null).run();

    expect(result.stop_reason).toBe("no_matching_edge");
    expect(result.error_detail).toBe("do_not_call");
  });
});
