import type { CanonicalFlow } from "./flow-schema.js";
import { classifyNodeType } from "./node-types.js";

// Tier 2: graph integrity as a REPORT, not a reject — exactly how Plivo's own
// console behaves (it surfaces validation_errors in a popover but still saves the
// draft). `validateFlow` runs on an ALREADY-normalized CanonicalFlow and returns
// { errors, warnings, simulatable }. FATAL checks (no start, no reachable agent,
// dangling edge) block a run (simulatable=false); WARNING checks (intent/edge
// mismatch, unreachable node, duplicate names, blocked/unknown node on a
// reachable path) let the run proceed — the orchestrator mocks/ends gracefully.

export interface Issue {
  code: string;
  message: string;
  /** The node the issue is about, when applicable. */
  nodeId?: string;
}

export interface FlowReport {
  errors: Issue[];
  warnings: Issue[];
  /** false ⇒ at least one fatal issue; the caller must NOT start a run. */
  simulatable: boolean;
}

/** Intent ids + names declared on a node's config (edges key on either). */
function intentHandles(config: Record<string, unknown>): { ids: Set<string>; names: Set<string> } {
  const ids = new Set<string>();
  const names = new Set<string>();
  const intents = config.intents;
  if (Array.isArray(intents)) {
    for (const it of intents) {
      if (it && typeof it === "object") {
        const rec = it as Record<string, unknown>;
        if (rec.id != null) ids.add(String(rec.id));
        const name = rec.intent_name ?? rec.name;
        if (name != null) names.add(String(name));
      }
    }
  }
  return { ids, names };
}

/**
 * Compute the set of node ids reachable from the start node by following edges.
 * Used to scope warnings to the part of the graph the simulation would actually
 * walk — an unsupported node off in an unreachable corner isn't worth a warning,
 * but one on the happy path is.
 */
function reachableFrom(startId: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/**
 * Validate a normalized canonical flow. Reads `data.config` directly (the flow is
 * post-normalize, so config always lives there). Does not throw — every problem
 * is an Issue in the report.
 */
export function validateFlow(flow: CanonicalFlow): FlowReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const nodes = flow.nodes;
  const nodeIds = new Set(nodes.map((n) => n.id));

  // ── adjacency (source → [target...]) + edge integrity ──────────────────────
  const adjacency = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (!nodeIds.has(e.source)) {
      errors.push({ code: "dangling_edge_source", message: `edge source '${e.source}' references a missing node`, nodeId: e.source });
    }
    if (!nodeIds.has(e.target)) {
      errors.push({ code: "dangling_edge_target", message: `edge target '${e.target}' references a missing node`, nodeId: e.target });
    }
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }

  // ── FATAL: a start node must exist ──────────────────────────────────────────
  const startNode = nodes.find((n) => classifyNodeType(n.type) === "start") ?? null;
  if (!startNode) {
    errors.push({ code: "no_start_node", message: "flow has no start node" });
  }

  // ── FATAL: at least one agent node must be reachable ────────────────────────
  const reachable = startNode ? reachableFrom(startNode.id, adjacency) : new Set<string>();
  const reachableAgent = nodes.some((n) => classifyNodeType(n.type) === "agent" && (!startNode || reachable.has(n.id)));
  if (!reachableAgent) {
    // Distinguish "no agent at all" from "agent exists but unreachable" for a
    // clearer message, but both are fatal — there's no one for the customer to talk to.
    const anyAgent = nodes.some((n) => classifyNodeType(n.type) === "agent");
    errors.push({
      code: "no_reachable_agent",
      message: anyAgent ? "flow has no agent node reachable from start" : "flow has no agent node to converse with",
    });
  }

  // ── WARNING: duplicate node names (config.name collisions) ──────────────────
  const nameCounts = new Map<string, string[]>();
  for (const n of nodes) {
    const name = typeof n.data?.config?.name === "string" ? (n.data.config.name as string) : "";
    if (!name) continue;
    const list = nameCounts.get(name) ?? [];
    list.push(n.id);
    nameCounts.set(name, list);
  }
  for (const [name, ids] of nameCounts) {
    if (ids.length > 1) {
      warnings.push({ code: "duplicate_node_name", message: `node name '${name}' is used by ${ids.length} nodes (${ids.join(", ")})` });
    }
  }

  // ── per-node warnings ───────────────────────────────────────────────────────
  // Outgoing-edge handles keyed by source node (for the intent↔edge cross-check).
  const outHandlesBySource = new Map<string, Set<string>>();
  for (const e of flow.edges) {
    const set = outHandlesBySource.get(e.source) ?? new Set<string>();
    if (e.sourceHandle != null) set.add(e.sourceHandle);
    outHandlesBySource.set(e.source, set);
  }

  for (const n of nodes) {
    const kind = classifyNodeType(n.type);
    const onReachablePath = !startNode || reachable.has(n.id);

    // WARNING: blocked / unknown node type sitting on a reachable path.
    if (onReachablePath && (kind === "blocked" || kind === "unknown")) {
      warnings.push({
        code: kind === "blocked" ? "blocked_node_type" : "unknown_node_type",
        message: `node type '${n.type}' is ${kind === "blocked" ? "unsupported" : "unknown"} — it will be mocked through with a default outcome`,
        nodeId: n.id,
      });
    }

    // WARNING: unreachable node (anything not reachable from start, excluding the
    // start node itself). Only meaningful when a start node exists.
    if (startNode && n.id !== startNode.id && !reachable.has(n.id)) {
      warnings.push({ code: "unreachable_node", message: `node '${n.id}' is not reachable from the start node`, nodeId: n.id });
    }

    // Intent ↔ edge cross-check for agent nodes.
    if (kind === "agent") {
      const { ids, names } = intentHandles(n.data?.config ?? {});
      const outHandles = outHandlesBySource.get(n.id) ?? new Set<string>();
      // Each declared intent should have a matching outgoing edge. Real edges key
      // on the intent's UUID (`id`); fixtures sometimes key on `intent_name`. Warn
      // only when the intent is reachable by NEITHER its id nor any of its names —
      // an over-eager warning here would fire on every real flow.
      const matchedByAnyName = [...names].some((nm) => outHandles.has(nm));
      for (const id of ids) {
        if (!outHandles.has(id) && !matchedByAnyName) {
          warnings.push({ code: "intent_without_edge", message: `node '${n.id}' declares intent '${id}' with no matching outgoing edge`, nodeId: n.id });
        }
      }
      // Each outgoing edge handle should match a declared intent (by id or name).
      for (const handle of outHandles) {
        if (!ids.has(handle) && !names.has(handle)) {
          warnings.push({ code: "edge_without_intent", message: `node '${n.id}' has an outgoing edge handle '${handle}' that matches no declared intent`, nodeId: n.id });
        }
      }
    }
  }

  return { errors, warnings, simulatable: errors.length === 0 };
}
