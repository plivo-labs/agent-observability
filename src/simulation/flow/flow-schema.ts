import { z } from "zod";

// The one fixed, authoritative schema for a Plivo flow_json (the canonical
// "Agent Flow 3" shape AO consumes after normalization). Tier 1 of the layered
// design: STRICT on the structural envelope the orchestrator depends on, LENIENT
// (.passthrough()) on open-ended node config so upstream config changes and brand
// new node types never reject a valid flow. We do NOT out-strict the runtime —
// graph integrity is reported by validateFlow (Tier 2), not rejected here.
//
// `.passthrough()` (zod) keeps any extra keys on an object instead of stripping
// them — important because node config is an open map the orchestrator reads by
// field access; we must not silently drop fields we don't model.

/** An intent declared on an agent (or branch) node. Open map — only `id` matters
 *  structurally (edges key on it), the rest is read leniently downstream. */
const Intent = z
  .object({
    id: z.string(),
    intent_name: z.string().optional(),
    intent_instructions: z.string().optional(),
  })
  .passthrough();

const AgentConfig = z
  .object({
    instructions: z.string().optional(),
    intents: z.array(Intent).default([]),
    extract_variables: z
      .array(
        z
          .object({
            variable_name: z.string().nullable().optional(),
            variable_instructions: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    actions: z.array(z.unknown()).optional(),
  })
  .passthrough(); // never reject extra fields

const BranchConfig = z
  .object({
    conditions: z.array(z.object({ alias: z.string() }).passthrough()).optional(),
    intents: z.array(Intent).optional(),
  })
  .passthrough();

// AgentConfig / BranchConfig are exported for callers that want the typed config
// shapes; the Node schema keeps `config` a permissive record so EVERY node type
// (known or not) parses. The discriminated typing happens at read time, not parse
// time — matching the runtime's "config is a generic map" contract.
export { Intent, AgentConfig, BranchConfig };

const Node = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    // Canonical config location is `data.config`. Both locations are tolerated
    // PRE-normalize so a parse before normalization (e.g. CanonicalFlow.parse on
    // a half-canonical input) doesn't choke; normalizeFlow collapses them to
    // `data.config` only.
    data: z.object({ config: z.record(z.string(), z.unknown()).default({}) }).partial().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough(); // both config locations tolerated pre-normalize

const Edge = z
  .object({
    source: z.string(),
    target: z.string(),
    sourceHandle: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

export const CanonicalFlow = z
  .object({
    flow_name: z.string().optional(),
    // systemPrompt is either the prompt text or the console's
    // { prompt, all_nodes_enabled } object. flowGlobals reads either.
    systemPrompt: z
      .union([
        z.string(),
        z
          .object({ prompt: z.string().default(""), all_nodes_enabled: z.boolean().optional() })
          .passthrough(),
      ])
      .default(""),
    agentSettings: z
      .object({
        voice_ai_config: z.unknown().optional(),
        knowledge_base_ids: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    global_meta: z.object({ stt_guidance: z.string().optional() }).passthrough().optional(),
    nodes: z.array(Node).min(1),
    edges: z.array(Edge).default([]),
  })
  .passthrough();

export type CanonicalFlow = z.infer<typeof CanonicalFlow>;
export type CanonicalNode = z.infer<typeof Node>;
export type CanonicalEdge = z.infer<typeof Edge>;
