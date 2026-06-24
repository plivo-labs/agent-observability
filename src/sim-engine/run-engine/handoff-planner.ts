// AO Simulation Engine — handoff plan (output_state_config for livekit's intent handler).
//
// Port of the reference worker `usecases/simulation_eval/handoff_planner.go` (+ the three helpers
// it borrows from edge_resolver.go: resolveIntentSourceHandle, resolvePromptEdge,
// hasOutgoingAIConversationTarget — ported privately here so this file stays self-contained
// and does not collide with run-engine/edge-resolver.ts).
//
// `computeHandoffPlan` walks the flow graph from an AI node, once per intent, resolving
// skips through MOCKED non-AI nodes via world_state, and returns the plan livekit's
// intent_handler consumes. Keys are intent_name (the `handoff_<intent_name>` tool
// convention). Entry shapes:
//   - AI target: { node_uuid, model: <raw target ai_agent_v2 config>, template_vars: {srcAiNodeId: [varNames]} }
//   - Terminal:  { type: "end_conversation", end_message }
// Intents whose walk fails (missing edge / cycle / unsupported node type / 20-hop cap) are
// OMITTED — livekit's continue_ai falls back to ending the session when the key is absent.
//
// GRAPH NOTE: this planner needs each edge's `data.nodeVars` (to build `template_vars`) and
// each node's `data.config.name` (an alternate world_state key). AO's shared
// simulation/flow/graph.ts FlowGraph is a leaner orchestrator view that drops edge `data`,
// so we parse our OWN minimal graph here — `buildHandoffGraph` mirrors the worker's
// ParseFlowGraph for exactly the fields the plan reads (id/type/config/configName + edge
// source/target/sourceHandle/data). The flow is assumed already CANONICAL (data.config).

import type { VariableStore } from "./variable-renderer.js";
import type { WorldStateEntry } from "../schema.js";
import { isRecord, deepCopyMap } from "../json.js";
import { defaultMockedOutcome } from "./flow-executor.js";

// ── Graph types (mirror the worker's FlowNode / FlowEdge / FlowGraph) ───────────────────

export interface HandoffNode {
  id: string;
  type: string;
  /** from data.config */
  config: Record<string, unknown>;
  /** from data.config.name — "" when absent (NOT defaulted to id; the worker leaves it ""). */
  configName: string;
}

export interface HandoffEdge {
  source: string;
  target: string;
  sourceHandle: string;
  /** full edge.data (carries `nodeVars`); undefined when the edge has none. */
  data?: Record<string, unknown>;
}

export interface HandoffGraph {
  nodes: Map<string, HandoffNode>;
  /** outgoing edges keyed by source node id (the worker's NodeEdges). */
  nodeEdges: Map<string, HandoffEdge[]>;
}

/**
 * Parse a CANONICAL flow_json into the graph the handoff planner walks. Mirrors the worker's
 * ParseFlowGraph for the fields the plan reads: node id/type, `data.config` (→ config),
 * `data.config.name` (→ configName, "" when absent), and edges with their full `data`
 * (so `nodeVars` survives). Nodes with no id and edges missing source/target are dropped,
 * matching Go.
 */
export function buildHandoffGraph(flow: unknown): HandoffGraph {
  const f = (flow ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(f["nodes"]) ? (f["nodes"] as unknown[]) : [];
  const rawEdges = Array.isArray(f["edges"]) ? (f["edges"] as unknown[]) : [];

  const nodes = new Map<string, HandoffNode>();
  for (const raw of rawNodes) {
    if (!isRecord(raw)) continue;
    const id = typeof raw["id"] === "string" ? raw["id"] : "";
    if (id === "") continue;
    const type = typeof raw["type"] === "string" ? (raw["type"] as string) : "";
    let config: Record<string, unknown> = {};
    let configName = "";
    const data = raw["data"];
    if (isRecord(data) && isRecord(data["config"])) {
      config = data["config"] as Record<string, unknown>;
      const name = config["name"];
      if (typeof name === "string") configName = name;
    }
    nodes.set(id, { id, type, config, configName });
  }

  const nodeEdges = new Map<string, HandoffEdge[]>();
  for (const raw of rawEdges) {
    if (!isRecord(raw)) continue;
    const source = typeof raw["source"] === "string" ? (raw["source"] as string) : "";
    const target = typeof raw["target"] === "string" ? (raw["target"] as string) : "";
    if (source === "" || target === "") continue;
    const sourceHandle = typeof raw["sourceHandle"] === "string" ? (raw["sourceHandle"] as string) : "";
    const data = isRecord(raw["data"]) ? (raw["data"] as Record<string, unknown>) : undefined;
    const edge: HandoffEdge = { source, target, sourceHandle, data };
    const list = nodeEdges.get(source) ?? [];
    list.push(edge);
    nodeEdges.set(source, list);
  }

  return { nodes, nodeEdges };
}

// ── The plan ─────────────────────────────────────────────────────────────────────────

/** One entry in the returned plan: an AI-target hop or a terminal end_conversation. */
export type HandoffEntry =
  | { node_uuid: string; model: Record<string, unknown>; template_vars: Record<string, string[]> }
  | { type: "end_conversation"; end_message: string };

const MAX_HOPS = 20;

/**
 * Build the handoff plan for an AI node: one entry per intent (keyed by intent_name). Returns
 * an empty object when `currentNode` is not an ai_agent_v2, the graph is missing, or the node
 * declares no `intents` array — all matching Go.
 */
export function computeHandoffPlan(
  currentNode: HandoffNode | null | undefined,
  graph: HandoffGraph | null | undefined,
  worldState: Record<string, WorldStateEntry> | null | undefined,
  variableStore: VariableStore | null | undefined,
): Record<string, HandoffEntry> {
  const plan: Record<string, HandoffEntry> = {};
  if (!currentNode || currentNode.type !== "ai_agent_v2" || !graph) return plan;

  const intentsRaw = currentNode.config["intents"];
  if (!Array.isArray(intentsRaw)) return plan;

  for (const raw of intentsRaw) {
    if (!isRecord(raw)) continue;
    const intentName = typeof raw["intent_name"] === "string" ? (raw["intent_name"] as string) : "";
    if (intentName === "") continue;
    const entry = walkFromIntent(currentNode, raw, graph, worldState, variableStore);
    if (entry !== null) plan[intentName] = entry;
  }

  return plan;
}

/**
 * Resolve the edge out of `currentNode` for `intent` and walk through mocked non-AI nodes
 * until landing on another ai_agent_v2 or a terminal. Returns null if the walk fails or hits
 * the hop cap. Faithful port of `walkFromIntent`, including the per-node-type source-id used
 * when collecting nodeVars (call_forward uses the call_forward node's id; every other hop
 * uses the ORIGINAL AI node's id — a subtlety the worker's tests pin).
 */
function walkFromIntent(
  currentNode: HandoffNode,
  intent: Record<string, unknown>,
  graph: HandoffGraph,
  worldState: Record<string, WorldStateEntry> | null | undefined,
  variableStore: VariableStore | null | undefined,
): HandoffEntry | null {
  const intentName = typeof intent["intent_name"] === "string" ? (intent["intent_name"] as string) : "";
  const intentId = typeof intent["id"] === "string" ? (intent["id"] as string) : "";

  const startEdge = findIntentEdge(graph, currentNode.id, intentId, intentName);
  if (!startEdge) return null;

  const templateVars: Record<string, string[]> = {};
  collectEdgeNodeVars(templateVars, currentNode.id, startEdge);

  let currentId = startEdge.target;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const node = graph.nodes.get(currentId);
    if (!node) return null;

    switch (node.type) {
      case "ai_agent_v2":
        return {
          node_uuid: node.id,
          model: deepCopyMap(node.config),
          template_vars: templateVars,
        };

      case "end_conversation":
        return endConversationEntry(node, variableStore);

      case "call_forward": {
        if (!hasOutgoingAIConversationTarget(graph, node.id)) {
          return endConversationEntry(node, variableStore);
        }
        const nextEdge = resolveMockedOutgoingEdge(graph, node, worldState);
        if (!nextEdge) {
          return endConversationEntry(node, variableStore);
        }
        // NOTE: call_forward collects under the call_forward node's id (node.id), unlike the
        // other mocked types below which collect under the original AI node's id.
        collectEdgeNodeVars(templateVars, node.id, nextEdge);
        currentId = nextEdge.target;
        break;
      }

      case "ai_action":
      case "http_request":
      case "branch_v2": {
        const nextEdge = resolveMockedOutgoingEdge(graph, node, worldState);
        if (!nextEdge) return null;
        collectEdgeNodeVars(templateVars, currentNode.id, nextEdge);
        currentId = nextEdge.target;
        break;
      }

      case "initiate_call": {
        const nextEdge = findEdgeBySourceHandle(graph, node.id, "answered");
        if (!nextEdge) return null;
        collectEdgeNodeVars(templateVars, currentNode.id, nextEdge);
        currentId = nextEdge.target;
        break;
      }

      case "prompt": {
        const nextEdge = resolvePromptEdge(graph, node.id);
        if (!nextEdge) return null;
        collectEdgeNodeVars(templateVars, currentNode.id, nextEdge);
        currentId = nextEdge.target;
        break;
      }

      default:
        return null;
    }
  }

  return null;
}

/** Build a terminal end_conversation entry, rendering the resolved end message via the store. */
function endConversationEntry(node: HandoffNode, variableStore: VariableStore | null | undefined): HandoffEntry {
  let endMessage = firstString(
    stringFromCfg(node.config, "end_message"),
    stringFromCfg(node.config, "message"),
    stringFromCfg(node.config, "text"),
  );
  if (variableStore && endMessage !== "") endMessage = variableStore.render(endMessage);
  return { type: "end_conversation", end_message: endMessage };
}

/** Prefer the intent UUID handle (how ai_agent_v2 intent edges are stored), fall back to the
 *  intent name. Mirrors Go `findIntentEdge`. */
function findIntentEdge(
  graph: HandoffGraph,
  fromNodeId: string,
  intentId: string,
  intentName: string,
): HandoffEdge | null {
  if (intentId !== "") {
    const e = findEdgeBySourceHandle(graph, fromNodeId, intentId);
    if (e) return e;
  }
  if (intentName !== "") {
    const e = findEdgeBySourceHandle(graph, fromNodeId, intentName);
    if (e) return e;
  }
  return null;
}

/** First outgoing edge of `nodeId` whose sourceHandle === `sourceHandle`. Mirrors Go. */
function findEdgeBySourceHandle(graph: HandoffGraph, nodeId: string, sourceHandle: string): HandoffEdge | null {
  const edges = graph.nodeEdges.get(nodeId) ?? [];
  for (const e of edges) {
    if (e.sourceHandle === sourceHandle) return e;
  }
  return null;
}

/**
 * Pick the outgoing edge for a mocked non-AI node using the world_state outcome if present,
 * otherwise a deterministic default. For ai_action, the outcome is resolved to the matching
 * intent UUID handle when possible. Mirrors Go `resolveMockedOutgoingEdge`.
 */
function resolveMockedOutgoingEdge(
  graph: HandoffGraph,
  node: HandoffNode,
  worldState: Record<string, WorldStateEntry> | null | undefined,
): HandoffEdge | null {
  const entry = lookupWorldStateEntry(worldState, node);
  let outcome = entry?.outcome ?? "";
  if (outcome === "") outcome = defaultMockedOutcome(node);

  let sourceHandle = outcome;
  if (node.type === "ai_action") {
    const resolved = resolveIntentSourceHandle(node, outcome);
    if (resolved.ok) sourceHandle = resolved.id;
  }
  return findEdgeBySourceHandle(graph, node.id, sourceHandle);
}

/** world_state lookup: node id first, then config name (only when non-empty). Mirrors Go. */
function lookupWorldStateEntry(
  worldState: Record<string, WorldStateEntry> | null | undefined,
  node: HandoffNode,
): WorldStateEntry | null {
  if (!worldState) return null;
  if (Object.prototype.hasOwnProperty.call(worldState, node.id)) return worldState[node.id];
  if (node.configName !== "" && Object.prototype.hasOwnProperty.call(worldState, node.configName)) {
    return worldState[node.configName];
  }
  return null;
}

/**
 * Extract the variable names referenced in `edge.data.nodeVars` (each `"{{NodeName.var}}"`)
 * and append them under `sourceAiNodeId`. livekit's intent handler looks these up by
 * node_uuid to block a handoff until the named vars are extracted. Mirrors Go
 * `collectEdgeNodeVars`: strip `{`/`}`/spaces, take the substring after the LAST dot.
 */
function collectEdgeNodeVars(collected: Record<string, string[]>, sourceAiNodeId: string, edge: HandoffEdge | null): void {
  if (!edge || !edge.data) return;
  const nodeVarsRaw = edge.data["nodeVars"];
  if (!Array.isArray(nodeVarsRaw)) return;
  for (const raw of nodeVarsRaw) {
    if (typeof raw !== "string") continue;
    const stripped = trimCharset(raw, "{} ");
    const dot = stripped.lastIndexOf(".");
    if (dot < 0) continue;
    const varName = stripped.slice(dot + 1);
    if (varName === "") continue;
    (collected[sourceAiNodeId] ??= []).push(varName);
  }
}

// ── edge_resolver.go helpers (ported privately for self-containment) ────────────────────

/** prompt node: prefer the "prompt_completed" handle, fall back to "success". Mirrors Go `resolvePromptEdge`. */
function resolvePromptEdge(graph: HandoffGraph, nodeId: string): HandoffEdge | null {
  const edges = graph.nodeEdges.get(nodeId) ?? [];
  for (const e of edges) if (e.sourceHandle === "prompt_completed") return e;
  for (const e of edges) if (e.sourceHandle === "success") return e;
  return null;
}

/** True if any outgoing edge of `nodeId` targets an ai_agent_v2 node. Mirrors Go `hasOutgoingAIConversationTarget`. */
function hasOutgoingAIConversationTarget(graph: HandoffGraph, nodeId: string): boolean {
  const edges = graph.nodeEdges.get(nodeId) ?? [];
  for (const e of edges) {
    const target = graph.nodes.get(e.target);
    if (target && target.type === "ai_agent_v2") return true;
  }
  return false;
}

/**
 * Resolve an intent NAME to the intent UUID to use as a sourceHandle. Returns `{ ok: true, id }`
 * when matched (by intent_name → its id, or when the value already equals an intent id, i.e.
 * the LLM returned the UUID directly), else `{ ok: false }`. Mirrors Go `resolveIntentSourceHandle`
 * (its `(string, bool)` return — distinct from graph.ts's `intentSourceHandle`, which has no
 * "found" signal and falls back to the name; this planner's ai_action branch needs the boolean).
 */
function resolveIntentSourceHandle(node: HandoffNode, intentName: string): { ok: true; id: string } | { ok: false; id: "" } {
  const intentsRaw = node.config["intents"];
  if (!Array.isArray(intentsRaw)) return { ok: false, id: "" };
  for (const raw of intentsRaw) {
    if (!isRecord(raw)) continue;
    const name = typeof raw["intent_name"] === "string" ? (raw["intent_name"] as string) : "";
    const id = typeof raw["id"] === "string" ? (raw["id"] as string) : "";
    if (intentName === name && id !== "") return { ok: true, id };
    if (intentName === id) return { ok: true, id }; // LLM returned the UUID directly
  }
  return { ok: false, id: "" };
}

// ── small helpers (mirror the Go free functions) ────────────────────────────────────────

function stringFromCfg(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key];
  return typeof v === "string" ? v : "";
}

function firstString(...vals: string[]): string {
  for (const v of vals) if (v !== "") return v;
  return "";
}

/** Trim any of the characters in `chars` from both ends (Go `strings.Trim(s, chars)`). */
function trimCharset(s: string, chars: string): string {
  const set = new Set(chars);
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start])) start++;
  while (end > start && set.has(s[end - 1])) end--;
  return s.slice(start, end);
}
