// AO Simulation Engine — FlowGraph parser + traversal orchestrator.
//
// Faithful port of the reference worker `usecases/simulation_eval/flow_orchestrator.go`
// (`ParseFlowGraph` + the `FlowOrchestrator.Run` traversal loop and its
// `executeMockedNode` / `defaultMockedOutcome` helpers).
//
// PURE — no Redis, DB, or HTTP. AI-node execution is delegated to the
// injected `AINodeExecutor` (the only outside seam); the concrete impl is
// wired later in Stage 6.
//
// Control-flow note: Go uses `break` inside a `switch` (which exits the
// switch, not the loop) followed by `if result.StopReason != "" { break }`
// to leave the loop. TS `switch`/`for` don't share that idiom, so each
// case sets state and the post-switch flag check decides whether to leave
// the loop — preserving the worker's exact semantics (e.g. `start` and
// `initiate_call` fall through to edge resolution; `end_conversation`
// returns immediately).

import { EdgeResolver } from "./edge-resolver.js";
import { resolveStartTrigger } from "./edge-resolver.js";
import type {
  AINodeExecutor,
  FlowEdge,
  FlowGraph,
  FlowNode,
  NodeExecutionResult,
  OrchestratorResult,
  WorldStateEntry,
} from "./flow-types.js";
import {
  StopReasonEndConversation,
  StopReasonError,
  StopReasonMaxTurns,
  StopReasonUnsupportedNode,
  VariableStore,
} from "./flow-types.js";

export class FlowOrchestrator {
  private readonly graph: FlowGraph;
  private readonly edgeResolver: EdgeResolver;
  private readonly variableStore: VariableStore;
  private readonly worldState: Map<string, WorldStateEntry>;
  private readonly aiExecutor: AINodeExecutor | null;
  private readonly maxTurns: number;

  constructor(
    graph: FlowGraph,
    worldState: Map<string, WorldStateEntry> | null,
    maxTurns: number,
    aiExecutor: AINodeExecutor | null,
  ) {
    this.graph = graph;
    this.edgeResolver = new EdgeResolver(graph);
    this.variableStore = new VariableStore();
    this.worldState = worldState ?? new Map();
    this.aiExecutor = aiExecutor;
    this.maxTurns = maxTurns;
  }

  /** Seed start-node trigger params into the variable store as `{trigger}.params.{key}`. */
  seedStartNodeParams(params: Record<string, unknown>): void {
    if (!params || Object.keys(params).length === 0) {
      return;
    }
    const startNode = this.graph.nodes.get(this.graph.startNodeId) ?? null;
    let configName = startNode?.configName ?? "";
    if (configName === "") {
      configName = "Start";
    }
    const triggerType = resolveStartTrigger(startNode);
    const vars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      vars[`${triggerType}.params.${k}`] = v;
    }
    this.variableStore.set(configName, this.graph.startNodeId, vars);
  }

  /** Walk the flow from the start node, delegating ai_agent_v2 nodes to the injected executor. */
  async run(): Promise<OrchestratorResult> {
    let currentNodeId = this.graph.startNodeId;
    const result: OrchestratorResult = {
      stop_reason: "",
      nodes_visited: [],
      last_node_id: "",
      last_node_type: "",
      turn_count: 0,
    };
    let turnCount = 0;

    // The main traversal loop. Each iteration may: (a) `return` directly for
    // terminal nodes; (b) set `result.stop_reason` and break the loop;
    // (c) advance `currentNodeId` and continue; or (d) fall through to the
    // shared post-switch edge resolution.
    loop: for (;;) {
      const node = this.graph.nodes.get(currentNodeId);
      if (!node) {
        result.stop_reason = StopReasonError;
        result.error_detail = "node not found in graph: " + currentNodeId;
        break;
      }

      result.nodes_visited.push(currentNodeId);

      let execResult: NodeExecutionResult | null = null;

      switch (node.type) {
        case "start":
          execResult = { outcome: resolveStartTrigger(node), variables: {}, message: "" };
          break;

        case "end_conversation":
          result.stop_reason = StopReasonEndConversation;
          result.last_node_id = currentNodeId;
          result.last_node_type = node.type;
          result.turn_count = turnCount;
          return result;

        case "call_forward": {
          execResult = this.executeMockedNode(node);
          this.variableStore.set(node.configName, node.id, execResult.variables);

          const { nextNodeId, stopReason, errorDetail } = this.edgeResolver.resolveNextNode(currentNodeId, execResult);
          if (stopReason !== "") {
            result.stop_reason = stopReason;
            result.error_detail = errorDetail;
            break loop;
          }
          const nextNode = this.graph.nodes.get(nextNodeId);
          if (!nextNode || nextNode.type !== "ai_agent_v2") {
            result.stop_reason = StopReasonEndConversation;
            result.last_node_id = currentNodeId;
            result.last_node_type = node.type;
            result.turn_count = turnCount;
            return result;
          }
          currentNodeId = nextNodeId;
          continue;
        }

        case "ai_agent_v2": {
          turnCount++;
          if (turnCount > this.maxTurns) {
            result.stop_reason = StopReasonMaxTurns;
            break;
          }
          if (!this.aiExecutor) {
            // Mirror the Go nil-result contract violation: an unconfigured
            // executor cannot satisfy the ai_agent_v2 contract.
            result.stop_reason = StopReasonError;
            result.error_detail = `ai_agent_v2 executor returned nil result without error at node ${node.id} (contract violation)`;
            result.last_node_id = node.id;
            result.last_node_type = node.type;
            result.turn_count = turnCount;
            throw new Error(`ai_agent_v2 executor returned nil result without error at node ${node.id}`);
          }
          let aiResult: NodeExecutionResult | null;
          try {
            aiResult = await this.aiExecutor.executeAINode(node, turnCount, this.variableStore);
          } catch (err) {
            result.stop_reason = StopReasonError;
            result.error_detail = err instanceof Error ? err.message : String(err);
            break;
          }
          if (aiResult == null) {
            // Contract violation: executor returned no result and did not throw.
            result.stop_reason = StopReasonError;
            result.error_detail = `ai_agent_v2 executor returned nil result without error at node ${node.id} (contract violation)`;
            result.last_node_id = node.id;
            result.last_node_type = node.type;
            result.turn_count = turnCount;
            throw new Error(`ai_agent_v2 executor returned nil result without error at node ${node.id}`);
          }
          execResult = aiResult;
          this.variableStore.set(node.configName, node.id, execResult.variables);

          // Empty intent = "stay on this node" (Pipecat behavior).
          // Re-enter the same ai_agent_v2 for another turn.
          if (execResult.outcome === "") {
            continue;
          }
          break;
        }

        case "initiate_call":
          execResult = { outcome: "answered", variables: {}, message: "" };
          break;

        case "ai_action":
        case "http_request":
        case "branch_v2":
          execResult = this.executeMockedNode(node);
          this.variableStore.set(node.configName, node.id, execResult.variables);
          break;

        case "prompt":
          execResult = { outcome: "success", variables: {}, message: "" };
          break;

        default:
          result.stop_reason = StopReasonUnsupportedNode;
          result.error_detail = node.type;
          break;
      }

      // Post-switch flag check (Go: `if result.StopReason != "" { break }`).
      // Reached by start / initiate_call / ai_action / http_request /
      // branch_v2 / prompt, and by ai_agent_v2 with a non-empty outcome.
      if (result.stop_reason !== "") {
        break;
      }

      // `execResult` is always set on any path that reaches here.
      const { nextNodeId, stopReason, errorDetail } = this.edgeResolver.resolveNextNode(
        currentNodeId,
        execResult as NodeExecutionResult,
      );
      if (stopReason !== "") {
        result.stop_reason = stopReason;
        result.error_detail = errorDetail;
        break;
      }

      currentNodeId = nextNodeId;
    }

    result.last_node_id = currentNodeId;
    const lastNode = this.graph.nodes.get(currentNodeId);
    if (lastNode) {
      result.last_node_type = lastNode.type;
    }
    result.turn_count = turnCount;
    // Drop the optional error_detail key when empty, mirroring Go's `omitempty`.
    if (result.error_detail === "" || result.error_detail === undefined) {
      delete result.error_detail;
    }
    return result;
  }

  /** Read mock outcome + variables from world_state for a mocked non-AI node. */
  private executeMockedNode(node: FlowNode): NodeExecutionResult {
    // Lookup prefers node ID over config name (matches the Go ordering).
    let entry = this.worldState.get(node.id);
    if (entry === undefined) {
      entry = this.worldState.get(node.configName);
    }
    if (entry === undefined) {
      return { outcome: defaultMockedOutcome(node), variables: {}, message: "" };
    }

    let outcome = entry.outcome ?? "";
    if (outcome === "") {
      outcome = defaultMockedOutcome(node);
    }

    const data = entry.data ?? {};

    return { outcome, variables: data, message: "" };
  }
}

/** Factory mirroring Go's `NewFlowOrchestrator`. */
export function newFlowOrchestrator(
  graph: FlowGraph,
  worldState: Map<string, WorldStateEntry> | null,
  maxTurns: number,
  aiExecutor: AINodeExecutor | null,
): FlowOrchestrator {
  return new FlowOrchestrator(graph, worldState, maxTurns, aiExecutor);
}

/** Per-node-type default outcome when world_state has no override (port of `defaultMockedOutcome`).
 *  Param is the structural shape BOTH `FlowNode` and the handoff planner's `HandoffNode` satisfy, so
 *  both reuse this single definition. */
export function defaultMockedOutcome(node: { type: string; config?: Record<string, unknown> | null }): string {
  switch (node.type) {
    case "branch_v2":
      return "no_match";
    case "http_request":
      return "success";
    case "call_forward":
      return "completed";
    case "ai_action": {
      const intents = node.config?.["intents"];
      if (Array.isArray(intents) && intents.length > 0) {
        const first = intents[0];
        if (typeof first === "object" && first !== null) {
          const f = first as Record<string, unknown>;
          const id = typeof f["id"] === "string" ? (f["id"] as string) : "";
          if (id !== "") {
            return id;
          }
          const name = typeof f["intent_name"] === "string" ? (f["intent_name"] as string) : "";
          if (name !== "") {
            return name;
          }
        }
      }
      break;
    }
  }
  return "success";
}

// --- Flow Graph Parsing ---

/**
 * Parse a flow into a `FlowGraph`. Faithful port of the worker's `ParseFlowGraph` — expects the
 * worker's `{ nodes, edges }` shape (flat `id`/`type` nodes; flat
 * `id`/`source`/`target`/`sourceHandle` edges), NOT the generator's stored `connections` shape.
 *
 * Accepts EITHER a JSON string (parsed here) or an already-parsed object, so a caller that already
 * parsed the flow (e.g. the orchestrator) need not parse it twice.
 *
 * Throws on invalid JSON, a missing `nodes` array, or no start node.
 */
export function parseFlowGraph(flow: string | Record<string, unknown>): FlowGraph {
  let parsed: unknown;
  if (typeof flow === "string") {
    try {
      parsed = JSON.parse(flow);
    } catch (err) {
      throw new Error(`invalid flow JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    parsed = flow;
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("flow JSON missing 'nodes' array");
  }
  const flowObj = parsed as Record<string, unknown>;

  const rawNodes = flowObj["nodes"];
  if (!Array.isArray(rawNodes)) {
    throw new Error("flow JSON missing 'nodes' array");
  }

  const rawEdgesUnknown = flowObj["edges"];
  const rawEdges = Array.isArray(rawEdgesUnknown) ? rawEdgesUnknown : [];

  const graph: FlowGraph = {
    nodes: new Map(),
    edges: [],
    nodeEdges: new Map(),
    startNodeId: "",
  };

  for (const raw of rawNodes) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const nodeMap = raw as Record<string, unknown>;

    const nodeId = typeof nodeMap["id"] === "string" ? (nodeMap["id"] as string) : "";
    const nodeType = typeof nodeMap["type"] === "string" ? (nodeMap["type"] as string) : "";
    if (nodeId === "") {
      continue;
    }

    const node: FlowNode = {
      id: nodeId,
      type: nodeType,
      configName: "",
      metaName: "",
      config: null,
      data: null,
    };

    const data = nodeMap["data"];
    if (typeof data === "object" && data !== null) {
      const dataObj = data as Record<string, unknown>;
      node.data = dataObj;
      const config = dataObj["config"];
      if (typeof config === "object" && config !== null) {
        const configObj = config as Record<string, unknown>;
        node.config = configObj;
        node.configName = typeof configObj["name"] === "string" ? (configObj["name"] as string) : "";
      }
      const meta = dataObj["meta"];
      if (typeof meta === "object" && meta !== null) {
        const metaObj = meta as Record<string, unknown>;
        node.metaName = typeof metaObj["name"] === "string" ? (metaObj["name"] as string) : "";
      }
    }

    graph.nodes.set(nodeId, node);

    if (nodeType === "start") {
      graph.startNodeId = nodeId;
    }
  }

  for (const raw of rawEdges) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const edgeMap = raw as Record<string, unknown>;

    const edgeDataUnknown = edgeMap["data"];
    const edgeData =
      typeof edgeDataUnknown === "object" && edgeDataUnknown !== null
        ? (edgeDataUnknown as Record<string, unknown>)
        : null;

    const edge: FlowEdge = {
      id: getStr(edgeMap, "id"),
      source: getStr(edgeMap, "source"),
      target: getStr(edgeMap, "target"),
      sourceHandle: getStr(edgeMap, "sourceHandle"),
      data: edgeData,
    };

    if (edge.source === "" || edge.target === "") {
      continue;
    }

    graph.edges.push(edge);
    const existing = graph.nodeEdges.get(edge.source);
    if (existing) {
      existing.push(edge);
    } else {
      graph.nodeEdges.set(edge.source, [edge]);
    }
  }

  if (graph.startNodeId === "") {
    throw new Error("flow has no start node");
  }

  return graph;
}

/** Read a string field from a map, returning "" when absent or non-string (port of Go `getStr`). */
function getStr(m: Record<string, unknown>, key: string): string {
  const v = m[key];
  return typeof v === "string" ? v : "";
}
