import { CanonicalFlow } from "./flow-schema.js";

// Tier 1.5: many shapes → one canonical. `normalizeFlow(input)` ingests ANY real
// Plivo flow_json — the config-service stored shape ("Shape A": `connections` with
// "nodeId.handle" endpoints, flat `config`, `global_meta.system_prompt`, a `phlo`
// object) OR the already-canonical shape ("Shape B": split `edges`, `data.config`,
// camelCase globals) — and returns the single CanonicalFlow the rest of AO trusts.
//
// This subsumes (and generalizes) the Plivo-only platform/plivo-flow-adapter:
// that adapter only knew Shape A; this knows both and auto-detects. The console's
// `inverseTransformFlowData` is the reference for the Shape A → canonical transform.
//
// Canonical decisions: config lives at `node.data.config`; globals are camelCase
// (`systemPrompt`/`agentSettings`/`global_meta`); edges are split
// `source`/`target`/`sourceHandle`. Everything else is converted into exactly that
// before `CanonicalFlow.parse()` — a parse failure here is a TRUE structural error.

// ── secret + UI-field stripping (ported from plivo-flow-adapter) ──────────────
// Conservative substring match: any config key that looks like a credential is
// dropped recursively, so a flow fetched/pasted for simulation never leaks auth
// tokens/passwords into the persisted run or the LLM generator.
const SECRET_KEY_RE = /(auth|token|password|secret|credential|api[_-]?key|bearer)/i;
// UI-only node fields the React Flow canvas persists; never part of flow_json.
const UI_NODE_FIELDS = ["position", "measured", "selected", "dragging", "width", "height"] as const;

/** Recursively drop secret-looking keys from a value (objects + arrays). */
function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue; // drop the secret entirely
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Split a stored connection endpoint ("nodeId.handle...") on the FIRST dot. The
 * node id is everything before the first dot; the handle is everything after it
 * (handles — intent UUIDs, branch outcomes — can themselves contain dashes; the
 * first-dot split keeps a handle intact). A bare value (no dot) is the node id
 * with no handle. Mirrors the platform adapter's splitEndpoint.
 */
function splitEndpoint(raw: string): { nodeId: string; handle: string | undefined } {
  const dot = raw.indexOf(".");
  if (dot < 0) return { nodeId: raw, handle: undefined };
  return { nodeId: raw.slice(0, dot), handle: raw.slice(dot + 1) || undefined };
}

/**
 * Pull a node's config out of wherever it lives (`data.config` canonical, or a
 * flat `config` stored shape), strip secrets + UI-only fields, and unwrap the
 * legacy `config.model` wrapper (the raw DB shape nests agent fields under
 * `config.model = { instructions, intents, ... }`). This is the leniency that
 * USED to live in graph.ts — centralized here so the parser can assume canonical.
 */
function normalizeNodeConfig(node: Record<string, unknown>): Record<string, unknown> {
  const dataConfig = isObject(node.data) && isObject(node.data.config) ? node.data.config : undefined;
  const flatConfig = isObject(node.config) ? node.config : undefined;
  let config = (dataConfig ?? flatConfig ?? {}) as Record<string, unknown>;

  // Unwrap the { model: { instructions, intents, ... } } wrapper so either the
  // hoisted console shape or the nested DB shape ends up flat.
  const model = config.model;
  if (isObject(model) && (model.instructions != null || Array.isArray(model.intents))) {
    config = { ...config, ...model };
  }

  const stripped = stripSecrets(config) as Record<string, unknown>;
  for (const f of UI_NODE_FIELDS) delete stripped[f];
  return stripped;
}

/** Build a canonical node `{ id, type, data: { config } }`. Drops nodes with no
 *  id (an unreferenceable node). Returns null for those so the caller can filter. */
function normalizeNode(raw: unknown): { id: string; type: string; data: { config: Record<string, unknown> } } | null {
  if (!isObject(raw)) return null;
  const id = raw.id == null ? "" : String(raw.id);
  if (!id) return null;
  const type = raw.type == null ? String((isObject(raw.data) ? raw.data.type : undefined) ?? raw.component ?? "") : String(raw.type);
  return { id, type, data: { config: normalizeNodeConfig(raw) } };
}

/**
 * Convert stored `connections[]` ("nodeId.handle" endpoints) into canonical
 * split edges. Carries `connection.data.id` onto the edge for stable identity.
 */
function edgesFromConnections(connections: unknown[]): Array<{ source: string; target: string; sourceHandle?: string; id?: string }> {
  const edges: Array<{ source: string; target: string; sourceHandle?: string; id?: string }> = [];
  for (const c of connections) {
    if (!isObject(c) || c.source == null || c.target == null) continue;
    const src = splitEndpoint(String(c.source));
    const tgt = splitEndpoint(String(c.target));
    const edge: { source: string; target: string; sourceHandle?: string; id?: string } = {
      source: src.nodeId,
      target: tgt.nodeId,
    };
    if (src.handle !== undefined) edge.sourceHandle = src.handle;
    const dataId = isObject(c.data) ? c.data.id : undefined;
    if (dataId != null) edge.id = String(dataId);
    edges.push(edge);
  }
  return edges;
}

/** Pass already-split `edges[]` through, normalizing field types. Drops edges
 *  missing a source or target. */
function edgesFromCanonical(rawEdges: unknown[]): Array<{ source: string; target: string; sourceHandle?: string; id?: string }> {
  const edges: Array<{ source: string; target: string; sourceHandle?: string; id?: string }> = [];
  for (const e of rawEdges) {
    if (!isObject(e) || e.source == null || e.target == null) continue;
    const edge: { source: string; target: string; sourceHandle?: string; id?: string } = {
      source: String(e.source),
      target: String(e.target),
    };
    if (e.sourceHandle != null) edge.sourceHandle = String(e.sourceHandle);
    if (e.id != null) edge.id = String(e.id);
    edges.push(edge);
  }
  return edges;
}

/**
 * Fold the flow-level globals from whatever spelling the source used into the
 * canonical camelCase fields. Reads (in priority order):
 *   - systemPrompt: `systemPrompt` ?? `system_prompt` ?? `global_meta.system_prompt`
 *   - agentSettings: `agentSettings` ?? `agent_settings`, merged with a
 *     voice_ai_config lifted from a `phlo` object (stored shape) when present.
 *   - global_meta: kept verbatim (carries stt_guidance).
 */
function foldGlobals(
  input: Record<string, unknown>,
): { systemPrompt: unknown; agentSettings: Record<string, unknown> | undefined; global_meta: Record<string, unknown> | undefined } {
  const globalMeta = isObject(input.global_meta) ? input.global_meta : undefined;

  // systemPrompt: prefer the canonical field, then snake_case, then the stored
  // global_meta.system_prompt.
  let systemPrompt: unknown = input.systemPrompt ?? input.system_prompt;
  if (systemPrompt === undefined && globalMeta && typeof globalMeta.system_prompt === "string") {
    systemPrompt = globalMeta.system_prompt;
  }

  // agentSettings: start from the canonical/snake_case object, then lift the
  // stored shape's phlo.voice_ai_config / event_callbacks in (without clobbering
  // an explicit agentSettings.voice_ai_config).
  const base = isObject(input.agentSettings) ? input.agentSettings : isObject(input.agent_settings) ? input.agent_settings : undefined;
  const phlo = isObject(input.phlo) ? input.phlo : undefined;
  let agentSettings: Record<string, unknown> | undefined = base ? { ...base } : undefined;
  if (phlo) {
    agentSettings = { ...(agentSettings ?? {}) };
    if (agentSettings.voice_ai_config === undefined && phlo.voice_ai_config !== undefined) {
      agentSettings.voice_ai_config = phlo.voice_ai_config;
    }
    if (agentSettings.event_callbacks === undefined && phlo.event_callbacks !== undefined) {
      agentSettings.event_callbacks = phlo.event_callbacks;
    }
  }

  return { systemPrompt, agentSettings, global_meta: globalMeta };
}

/**
 * Detect the stored "Shape A" — it has `connections` (the orchestrator's edges
 * live there) rather than `edges`, OR its edge endpoints are "nodeId.handle"
 * strings. We only need the `connections` signal in practice; the helper takes
 * the array so the call site reads clearly.
 */
function looksLikeStored(input: Record<string, unknown>): boolean {
  return Array.isArray(input.connections) && !Array.isArray(input.edges);
}

/**
 * Normalize ANY accepted flow_json shape into the single CanonicalFlow. Pure:
 * no I/O, no config. Tolerant of partial input on the way in (missing arrays
 * default to empty); the FINAL `CanonicalFlow.parse()` is the gate that enforces
 * the structural envelope (e.g. at least one node) — a throw here is a real
 * structural error the caller surfaces via the validation report / a 4xx.
 *
 * Idempotent: feeding an already-canonical flow back through is a no-op
 * (re-stripping already-stripped config, re-folding already-camelCase globals).
 */
export function normalizeFlow(input: unknown): CanonicalFlow {
  const flow = isObject(input) ? input : {};

  const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const nodes = rawNodes
    .map(normalizeNode)
    .filter((n): n is { id: string; type: string; data: { config: Record<string, unknown> } } => n !== null);

  const edges = looksLikeStored(flow)
    ? edgesFromConnections(flow.connections as unknown[])
    : edgesFromCanonical(Array.isArray(flow.edges) ? flow.edges : []);

  const { systemPrompt, agentSettings, global_meta } = foldGlobals(flow);

  const candidate: Record<string, unknown> = {
    nodes,
    edges,
    systemPrompt: systemPrompt ?? "",
  };
  if (typeof flow.flow_name === "string") candidate.flow_name = flow.flow_name;
  if (agentSettings !== undefined) candidate.agentSettings = agentSettings;
  if (global_meta !== undefined) candidate.global_meta = global_meta;

  return CanonicalFlow.parse(candidate);
}
