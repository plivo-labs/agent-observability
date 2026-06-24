// Parse a CANONICAL flow_json into a graph the orchestrator can walk. The flow is
// assumed already normalized (see flow/flow-normalize.ts): node config lives at
// `data.config`, globals are camelCase, edges are split `source`/`target`/
// optional `sourceHandle` (the intent or branch-outcome handle on the source's
// output). All shape leniency (flat config, `config.model` wrapper, snake_case
// globals, stored `connections`) is the normalizer's job — this parser does not
// guess. Mirrors the reference worker's ParseFlowGraph (Go): agent nodes talk to the
// user; control/action nodes are mocked via world_state; terminal nodes end it.

import { isAgentNode, isTerminalNode } from "./node-types.js";

export { isAgentNode, isTerminalNode };

export interface FlowNode {
  id: string;
  type: string;
  config: Record<string, any>;
  /** config.name — an alternate world_state key (mirrors the reference worker). */
  configName: string;
  isAgent: boolean;
  isTerminal: boolean;
}

export interface FlowEdge {
  source: string;
  target: string;
  /** Intent name (agent node) or branch outcome (control node) on the source. */
  sourceHandle?: string;
}

export interface FlowGraph {
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
  /** Outgoing edges keyed by source node id. */
  adjacency: Map<string, FlowEdge[]>;
  startNodeId: string | null;
}

export function parseFlowGraph(flow: any): FlowGraph {
  const rawNodes: any[] = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const nodes = new Map<string, FlowNode>();
  for (const n of rawNodes) {
    const id = String(n?.id ?? "");
    if (!id) continue;
    const type = String(n?.type ?? "");
    // Canonical: config always lives at `data.config` (the normalizer guarantees
    // it). No `data.config ?? config` guessing, no `config.model` unwrap — those
    // are the normalizer's responsibility.
    const config = (n?.data?.config ?? {}) as Record<string, any>;
    nodes.set(id, {
      id,
      type,
      config,
      configName: String(config?.name ?? id),
      isAgent: isAgentNode(type),
      isTerminal: isTerminalNode(type),
    });
  }

  const rawEdges: any[] = Array.isArray(flow?.edges) ? flow.edges : [];
  const edges: FlowEdge[] = rawEdges
    .filter((e) => e?.source != null && e?.target != null)
    .map((e) => ({
      source: String(e.source),
      target: String(e.target),
      sourceHandle: e?.sourceHandle != null ? String(e.sourceHandle) : undefined,
    }));

  const adjacency = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const list = adjacency.get(e.source) ?? [];
    list.push(e);
    adjacency.set(e.source, list);
  }

  const startNode = [...nodes.values()].find((n) => n.type === "start") ?? null;
  return { nodes, edges, adjacency, startNodeId: startNode?.id ?? null };
}

/** Intent names declared on an agent node (from config.intents[].intent_name). */
export function nodeIntents(node: FlowNode): string[] {
  const intents = node.config?.intents;
  if (!Array.isArray(intents)) return [];
  return intents.map((i: any) => String(i?.intent_name ?? i?.name ?? "")).filter(Boolean);
}

/**
 * Resolve an intent NAME (what the agent LLM emits) to the edge `sourceHandle` to
 * match — real flows key edges on the intent's `id` (UUID), not the name. Mirrors
 * the reference worker's resolveIntentSourceHandle: name → its `id`; if the value already
 * equals an intent `id` (LLM returned the UUID directly), pass it through; else
 * fall back to the name itself (handles fixtures whose edges key on intent_name).
 */
export function intentSourceHandle(node: FlowNode, intent: string): string {
  const intents = node.config?.intents;
  if (Array.isArray(intents)) {
    for (const it of intents) {
      const name = String(it?.intent_name ?? it?.name ?? "");
      const id = String(it?.id ?? "");
      if (intent === name && id) return id;
      if (intent === id && id) return id;
    }
  }
  return intent;
}
