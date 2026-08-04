// AO Simulation Engine — EdgeResolver.
//
// Faithful port of the reference worker `usecases/simulation_eval/edge_resolver.go`.
// Resolves the next node from (current node + execution result) via a
// node-type switch that derives a `sourceHandle`, then matches it against
// the node's outgoing edges. PURE — no Redis, DB, or HTTP.

import type { FlowEdge, FlowGraph, FlowNode, NodeExecutionResult, StopReason } from "./flow-types.js";
import {
  StopReasonEndConversation,
  StopReasonError,
  StopReasonNoMatchingEdge,
  StopReasonUnknownIntent,
  StopReasonUnsupportedNode,
} from "./flow-types.js";

/**
 * Result of edge resolution. Mirrors the Go return tuple
 * `(nextNodeID string, stopReason StopReason, errorDetail string)`.
 * A non-empty `stopReason` means the scenario should stop.
 */
export interface ResolveResult {
  nextNodeId: string;
  stopReason: StopReason | "";
  errorDetail: string;
}

export class EdgeResolver {
  private readonly graph: FlowGraph;

  constructor(graph: FlowGraph) {
    this.graph = graph;
  }

  /**
   * Determine the next node given the current node + its execution result.
   * Returns `{ nextNodeId, stopReason, errorDetail }`; a non-empty
   * `stopReason` halts traversal.
   */
  resolveNextNode(currentNodeId: string, result: NodeExecutionResult): ResolveResult {
    const node = this.graph.nodes.get(currentNodeId);
    if (!node) {
      return { nextNodeId: "", stopReason: StopReasonError, errorDetail: "node not found: " + currentNodeId };
    }

    let sourceHandle: string;

    switch (node.type) {
      case "start":
        sourceHandle = resolveStartTrigger(node);
        break;
      case "end_conversation":
        return { nextNodeId: "", stopReason: StopReasonEndConversation, errorDetail: "" };
      case "call_forward":
        sourceHandle = result.outcome;
        if (sourceHandle === "") {
          sourceHandle = "completed";
        }
        break;
      case "ai_agent_v2": {
        // result.outcome is the intent name — resolve to intent UUID for edge matching.
        const [intentUuid, found] = resolveIntentSourceHandle(node, result.outcome);
        if (!found) {
          return { nextNodeId: "", stopReason: StopReasonUnknownIntent, errorDetail: result.outcome };
        }
        sourceHandle = intentUuid;
        break;
      }
      case "initiate_call":
        sourceHandle = "answered";
        break;
      case "ai_action": {
        const [intentUuid, found] = resolveIntentSourceHandle(node, result.outcome);
        if (found) {
          sourceHandle = intentUuid;
        } else {
          sourceHandle = result.outcome;
          if (sourceHandle === "") {
            sourceHandle = "success";
          }
        }
        break;
      }
      case "http_request":
        sourceHandle = result.outcome;
        if (sourceHandle === "") {
          sourceHandle = "success";
        }
        break;
      case "branch_v2":
        sourceHandle = result.outcome;
        if (sourceHandle === "") {
          sourceHandle = "no_match";
        }
        break;
      case "contact_screening":
        // Screening dispositions double as literal edge sourceHandles
        // (reached / callback / wrong_contact / unavailable / declined /
        // do_not_call, plus "Voicemail Detected") — matching phlo-core's
        // output states. No intent-UUID indirection. The voicemail port is
        // the one asymmetry: the runtime disposition VALUE is "voicemail"
        // but the edge key is "Voicemail Detected" — accept both so a
        // world_state writer emitting the disposition still routes.
        sourceHandle = result.outcome;
        if (sourceHandle === "") {
          sourceHandle = "reached";
        } else if (sourceHandle === "voicemail") {
          sourceHandle = "Voicemail Detected";
        }
        break;
      case "prompt": {
        const edge = resolvePromptEdge(this.graph, currentNodeId);
        if (edge) {
          return { nextNodeId: edge.target, stopReason: "", errorDetail: "" };
        }
        return { nextNodeId: "", stopReason: StopReasonNoMatchingEdge, errorDetail: "" };
      }
      default:
        return { nextNodeId: "", stopReason: StopReasonUnsupportedNode, errorDetail: node.type };
    }

    // Find matching outgoing edge.
    for (const edge of this.graph.nodeEdges.get(currentNodeId) ?? []) {
      if (edge.sourceHandle === sourceHandle) {
        return { nextNodeId: edge.target, stopReason: "", errorDetail: "" };
      }
    }

    return { nextNodeId: "", stopReason: StopReasonNoMatchingEdge, errorDetail: sourceHandle };
  }
}

/** Prompt nodes prefer the `prompt_completed` handle, falling back to `success`. */
export function resolvePromptEdge(graph: FlowGraph, nodeId: string): FlowEdge | null {
  const edges = graph.nodeEdges.get(nodeId) ?? [];
  for (const e of edges) {
    if (e.sourceHandle === "prompt_completed") {
      return e;
    }
  }
  for (const e of edges) {
    if (e.sourceHandle === "success") {
      return e;
    }
  }
  return null;
}

/** Read the trigger type from `config.triggers[0]`, defaulting to `"http"`. */
export function resolveStartTrigger(node: FlowNode | null | undefined): string {
  const triggers = node?.config?.["triggers"];
  if (Array.isArray(triggers) && triggers.length > 0) {
    const t = triggers[0];
    if (typeof t === "string" && t !== "") {
      return t;
    }
  }
  return "http";
}

/**
 * Find the intent UUID to use as the sourceHandle. Matches `intentName`
 * against each intent's `intent_name`; also handles the case where the LLM
 * returns the UUID directly instead of the name. Returns `[uuid, found]`.
 */
export function resolveIntentSourceHandle(node: FlowNode, intentName: string): [string, boolean] {
  const intentsRaw = node.config?.["intents"];
  if (!Array.isArray(intentsRaw)) {
    return ["", false];
  }

  for (const raw of intentsRaw) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const intent = raw as Record<string, unknown>;
    const name = typeof intent["intent_name"] === "string" ? (intent["intent_name"] as string) : "";
    const id = typeof intent["id"] === "string" ? (intent["id"] as string) : "";

    if (intentName === name && id !== "") {
      return [id, true];
    }
    if (intentName === id) {
      // LLM returned the UUID directly.
      return [id, true];
    }
  }

  return ["", false];
}
