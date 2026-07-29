import { nodeConfig, nodeName, agentSettingsOf, extractEmbeddedActions, type MechanicalInventory } from "./inventory.js";
import { isRecord, stableStringify } from "../json.js";

// AO Simulation Engine — compact smoke-planner flow summary.
//
// In smoke mode the planner payload replaces the raw `flow_json` with this summary:
// the mechanical inventory already carries every ai_agent_v2 node's full instructions,
// the intent route map, variables, and action descriptions, so re-serializing the whole
// flow into the prompt only paid tokens for a second copy. The summary keeps ONLY what
// the inventory cannot express:
//   • agent_profile — the global agent persona/system prompt ("scope inferred from the
//     agent role" in the smoke prompt), stt_guidance, flow_name, KB presence,
//   • edge_topology — EVERY edge including non-intent ones (branch outcomes, prompt/http
//     success chains); the route inventory only sees intent-driven one-hop routes, and
//     the smoke prompt's "separate smoke units for nested branches" depends on these,
//   • node_digests — non-ai_agent_v2 nodes' existence + a capped config excerpt (the
//     run engine mocks these nodes, so outcomes/edges matter, not their full configs),
//   • start_node — payload_format with value types/defaults (the inventory keeps keys
//     only) + triggers,
//   • action_params — action input property names (the inventory keeps descriptions
//     only; "caller must provide X" units need the param names).
//
// Deterministic and pure: a byte-identical flow always yields a byte-identical summary
// (stable key order, sorted arrays) — the planner cache hashes it via the flag+version
// key parts. Bump SUMMARY_VERSION on any semantic change so cached plans built from an
// older summary shape can never be served for the new one.

type Dict = Record<string, any>;
const isObj = (v: unknown): v is Dict => isRecord(v);

export const SUMMARY_VERSION = 1;

/** Which payload the planner LLM receives. `summary` exists only in smoke mode. */
export type PlannerPayloadVariant = "full" | "summary";

/** Why the effective variant was chosen — logged per generation for OpenSearch. */
type PayloadVariantReason = "on" | "flag_off" | "degenerate_no_routes" | "summary_not_smaller";

interface SummaryEdge {
  source: string;
  handle: string;
  target: string;
  /** "intent" when the handle matches a source-node intent (id or name); "flow" for
   *  structural handles (branch outcomes like `eligible`/`no_match`, `success`, …). */
  kind: "intent" | "flow";
  intent_name?: string;
}

/** One entry per non-agent, non-start node: existence + name + a capped config excerpt.
 *  (The run engine mocks these nodes, so outcomes/edges matter, not their full configs.) */
interface NodeDigest {
  id: string;
  type: string;
  name: string;
  /** prompt nodes only: the spoken text (inherently short, directly useful for smoke goals). */
  text?: string;
  config_keys?: string[];
  config_excerpt?: string;
}

export interface SmokeFlowSummary {
  summary_version: number;
  agent_profile: {
    flow_name: string;
    system_prompt: string;
    stt_guidance: string;
    knowledge_base: { global_count: number; node_ids_with_kb: string[] };
  };
  edge_topology: SummaryEdge[];
  node_digests: NodeDigest[];
  start_node: { payload_format: Dict; triggers: string[] };
  action_params: Record<string, string[]>;
}

/** Cap for the generic per-node config excerpt (chars of stable JSON). */
const NODE_DIGEST_EXCERPT_CAP = 500;

/** The console ships systemPrompt as either the prompt string or { prompt, ... }. */
function coerceSystemPrompt(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isObj(raw) && typeof raw.prompt === "string") return raw.prompt;
  return "";
}

function buildAgentProfile(flow: Dict): SmokeFlowSummary["agent_profile"] {
  const globalMeta = isObj(flow.global_meta) ? flow.global_meta : {};
  const settings = agentSettingsOf(flow);
  const globalKb = Array.isArray(settings.knowledge_base_ids) ? settings.knowledge_base_ids : [];
  const nodeIdsWithKb: string[] = [];
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node) || !node.id) continue;
    const kb = nodeConfig(node).knowledge_base_ids;
    if (Array.isArray(kb) && kb.length > 0) nodeIdsWithKb.push(node.id);
  }
  return {
    flow_name: typeof flow.flow_name === "string" ? flow.flow_name : "",
    system_prompt: coerceSystemPrompt(flow.systemPrompt ?? flow.system_prompt),
    stt_guidance: typeof globalMeta.stt_guidance === "string" ? globalMeta.stt_guidance : "",
    knowledge_base: { global_count: globalKb.length, node_ids_with_kb: nodeIdsWithKb.sort() },
  };
}

/** Every edge, with intent handles resolved to their intent name. Matches like
 *  extractRouteInventory (sourceHandle === intent.id || intent name) EXCEPT it does
 *  not adopt the inventory's `intentId || "default"` name fallback for id-less
 *  intents — such an edge is labeled kind:"flow" instead (cosmetic only; the edge
 *  itself is still emitted with its handle and target). */
function buildEdgeTopology(flow: Dict): SummaryEdge[] {
  const intentsBySource = new Map<string, Dict[]>();
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node) || !node.id) continue;
    const intents = (nodeConfig(node).intents as Dict[]) || [];
    if (intents.length > 0) intentsBySource.set(node.id, intents.filter(isObj));
  }
  const edges: SummaryEdge[] = [];
  for (const edge of (flow.edges as Dict[]) || []) {
    if (!isObj(edge) || !edge.source || !edge.target) continue;
    const handle = edge.sourceHandle || "";
    let kind: SummaryEdge["kind"] = "flow";
    let intentName: string | undefined;
    for (const intent of intentsBySource.get(edge.source) || []) {
      const name = intent.intent_name || intent.name || "";
      if (handle !== "" && (handle === intent.id || handle === name)) {
        kind = "intent";
        intentName = name || intent.id;
        break;
      }
    }
    edges.push({ source: edge.source, handle, target: edge.target, kind, ...(intentName ? { intent_name: intentName } : {}) });
  }
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.handle.localeCompare(b.handle) || a.target.localeCompare(b.target));
  return edges;
}

/**
 * One digest per non-ai_agent_v2, non-start node. Agent nodes are already verbatim in
 * `inventory.nodes[].instructions` (duplicating them is the bulk this summary cuts);
 * the start node has its own block. The generic `config_keys` + capped excerpt means
 * an unknown/new node type degrades to a digest instead of vanishing.
 */
function buildNodeDigests(flow: Dict): NodeDigest[] {
  const digests: NodeDigest[] = [];
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node) || !node.id) continue;
    if (node.type === "ai_agent_v2" || node.type === "start") continue;
    const config = nodeConfig(node);
    const digest: NodeDigest = { id: node.id, type: node.type || "", name: nodeName(node) };
    // Best-effort curated field: a prompt node's spoken text is inherently short and
    // directly useful for smoke goals. Everything else rides the generic excerpt.
    if (node.type === "prompt") {
      const text = config.text || config.prompt || config.message || "";
      if (typeof text === "string" && text) digest.text = text;
    }
    const keys = Object.keys(config).sort();
    if (keys.length > 0) {
      digest.config_keys = keys;
      const excerpt = stableStringify(config);
      digest.config_excerpt = excerpt.length > NODE_DIGEST_EXCERPT_CAP ? excerpt.slice(0, NODE_DIGEST_EXCERPT_CAP) : excerpt;
    }
    digests.push(digest);
  }
  digests.sort((a, b) => a.id.localeCompare(b.id));
  return digests;
}

function buildStartNode(flow: Dict): SmokeFlowSummary["start_node"] {
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node) || node.type !== "start") continue;
    const config = nodeConfig(node);
    return {
      payload_format: isObj(config.payload_format) ? config.payload_format : {},
      triggers: Array.isArray(config.triggers) ? config.triggers.filter((t: unknown) => typeof t === "string") : [],
    };
  }
  return { payload_format: {}, triggers: [] };
}

/** Action input property names by mock_key (from the embedded action schemas). */
function buildActionParams(flow: Dict): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const embedded of extractEmbeddedActions(flow)) {
    for (const action of embedded.actions) {
      if (!action.schema_json) continue;
      try {
        const schema = JSON.parse(action.schema_json);
        const props = isObj(schema) && isObj(schema.properties) ? Object.keys(schema.properties).sort() : [];
        if (props.length > 0) params[action.mock_key] = props;
      } catch {
        // Malformed schema — the description (in the inventory) still covers the action.
      }
    }
  }
  return Object.keys(params)
    .sort()
    .reduce((acc: Record<string, string[]>, k) => {
      acc[k] = params[k];
      return acc;
    }, {});
}

/** Build the compact smoke-planner summary from a canonical flow (output of normalizeFlow). */
export function buildSmokeFlowSummary(flow: Dict): SmokeFlowSummary {
  return {
    summary_version: SUMMARY_VERSION,
    agent_profile: buildAgentProfile(flow),
    edge_topology: buildEdgeTopology(flow),
    node_digests: buildNodeDigests(flow),
    start_node: buildStartNode(flow),
    action_params: buildActionParams(flow),
  };
}

/** The effective planner payload, as a discriminated union: a summary payload always
 *  carries its summary (and the only reason it can exist is the flag being on), and a
 *  full payload can never smuggle one — the illegal combinations don't typecheck. */
export type ResolvedPlannerPayload =
  | { variant: "full"; reason: Exclude<PayloadVariantReason, "on"> }
  | { variant: "summary"; reason: "on"; summary: SmokeFlowSummary };

/**
 * Decide the effective planner payload for a smoke request. Deterministic in
 * (flow, inventory, requested) — which is why the planner cache only needs the
 * REQUESTED flag in its key: flowJson + mode are already hashed, and together they
 * fully determine this outcome. Falls back to the full flow when:
 *   • the flow has zero intent routes (edge-driven or degenerate routing — the
 *     planner's route-anchor grounding is too thin to trust a digest), or
 *   • the summary isn't actually smaller than the flow (tiny flows: no win, only risk).
 */
export function resolvePlannerPayload(flow: Dict, inventory: MechanicalInventory, requested: boolean): ResolvedPlannerPayload {
  if (!requested) return { variant: "full", reason: "flag_off" };
  if (inventory.routes.length === 0) {
    return { variant: "full", reason: "degenerate_no_routes" };
  }
  const summary = buildSmokeFlowSummary(flow);
  if (JSON.stringify(summary).length >= JSON.stringify(flow).length) {
    return { variant: "full", reason: "summary_not_smaller" };
  }
  return { variant: "summary", reason: "on", summary };
}
