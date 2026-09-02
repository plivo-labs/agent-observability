import { OUT_OF_SCOPE_ROUTE_TERMS } from "./combos.js";
import { isRecord } from "../json.js";

// AO Simulation Engine — flow-shaping helpers + the agent-runner inventory contract.
//
// agent-runner builds the mechanical inventory (reachable AI nodes, routes, mockable-outcome
// handles, terminals, the simulatable verdict); AO fetches it via LiveKitSimClient.inventory()
// and threads it through the planner/allocator/writer. This module also holds the flow-shaping
// helpers the writer + planner read directly off the canonical flow JSON (embedded actions,
// start-node params, outbound detection, node name/config, the out-of-scope route-term filter),
// plus the shared inventory types.

export interface FlowInventoryNode {
  id: string;
  type: string;
  name: string;
  instructions: string;
  intent_names: string[];
  extract_variables: string[];
}

export interface RouteInventoryItem {
  route_id: string;
  source_node_id: string;
  source_node_name: string;
  source_node_type: string;
  intent_id: string;
  intent_name: string;
  intent_instructions: string;
  target_node_id: string | null;
  target_node_name: string | null;
  target_node_type: string | null;
  support: "fully_executable" | "supported_terminal" | "blocked";
}

export interface VariableInventoryItem {
  node_id: string;
  node_name: string;
  variable_name: string;
  variable_instructions: string;
  variable_type?: string;
}

export interface ActionInventoryItem {
  node_id: string;
  node_name: string;
  mock_key: string;
  action_type: string;
  description: string;
}

export interface EmbeddedActionItem {
  action_type: string;
  mock_key: string;
  description: string;
  schema_json: string;
}

export interface EmbeddedActionsNode {
  node_uuid: string;
  node_name: string;
  actions: EmbeddedActionItem[];
}

/** A mockable non-AI node with its real outcome handles (branch aliases, http states, screening
 *  dispositions, …). Fed to the writer so it can pin a valid outcome per node. */
export interface MockableNode {
  node_uuid: string;
  name: string;
  type: string;
  outcome_handles: string[];
  default_outcome: string;
}

/** The mechanical facts the planner/allocator consume (the planner embeds the whole object). */
export interface MechanicalInventory {
  nodes: FlowInventoryNode[];
  routes: RouteInventoryItem[];
  variables: VariableInventoryItem[];
  actions: ActionInventoryItem[];
  languages: string[];
  is_outbound_call: boolean;
}

/** The full agent-runner inventory response (POST /v1/simulation/flow/inventory): the mechanical
 *  inventory the planner reads PLUS the walker facts (simulatable verdict, unsimulatable nodes,
 *  entry node, reachable AI nodes, per-node mockable handles, terminals). */
export interface FlowInventory extends MechanicalInventory {
  simulatable: boolean;
  unsimulatable: Array<{ node_uuid: string; name: string; type: string; reason: string }>;
  /** Walker's specific refusal reason when simulatable=false (absent on older agent-runner images). */
  unsimulatable_reason?: string | null;
  entry_node_uuid: string | null;
  reachable_ai_nodes: string[];
  mockable_nodes: MockableNode[];
  terminals: string[];
}

type Dict = Record<string, any>;
const isObj = (v: unknown): v is Dict => isRecord(v);

/** Stable JSON.stringify (recursively sorted keys) — mirrors Python json.dumps(sort_keys=True). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    isObj(v)
      ? Object.keys(v)
          .sort()
          .reduce((acc: Dict, k) => {
            acc[k] = v[k];
            return acc;
          }, {})
      : v,
  );
}

export function nodeConfig(node: Dict): Dict {
  const data = isObj(node.data) ? node.data : {};
  return isObj(data.config) ? data.config : {};
}

export function nodeName(node: Dict): string {
  const data = isObj(node.data) ? node.data : {};
  const meta = isObj(data.meta) ? data.meta : {};
  const config = nodeConfig(node);
  return config.name || meta.name || node.id || "Unknown node";
}

export function containsOutOfScopeRouteTerm(...values: unknown[]): boolean {
  const text = values.map((v) => String(v ?? "").toLowerCase()).join(" ");
  return OUT_OF_SCOPE_ROUTE_TERMS.some((term) => text.includes(term));
}

// ── embedded action extraction (conversational nodes) ──────────────────────────

/** Node types that carry embedded `actions[]` the scenario writer can mock. */
const EMBEDDED_ACTION_NODE_TYPES: ReadonlySet<string> = new Set(["ai_agent_v2", "agent_node"]);

function actionMockKey(action: Dict): string {
  switch (action.action_type) {
    case "EXECUTE_ACTION":
      return action.action_name || "";
    case "CUSTOM_CODE":
      return action.code_name || "";
    case "HTTP":
      return action.http_tool_name || "";
    default:
      return "";
  }
}

function actionDescription(action: Dict): string {
  switch (action.action_type) {
    case "EXECUTE_ACTION":
      return action.action_instructions || "";
    case "CUSTOM_CODE":
      return action.code_description || "";
    case "HTTP":
      return action.http_tool_description || "";
    default:
      return "";
  }
}

function actionSchema(action: Dict): unknown {
  switch (action.action_type) {
    case "EXECUTE_ACTION":
      return action.action_schema;
    case "CUSTOM_CODE":
      return action.code_function_schema;
    case "HTTP":
      return action.http_function_schema;
    default:
      return undefined;
  }
}

export function extractEmbeddedActions(flow: Dict): EmbeddedActionsNode[] {
  const result: EmbeddedActionsNode[] = [];
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node) || !EMBEDDED_ACTION_NODE_TYPES.has(String(node.type)) || !node.id) continue;
    const data = isObj(node.data) ? node.data : {};
    const config = isObj(data.config) ? data.config : {};
    const actions: EmbeddedActionItem[] = [];
    for (const action of (config.actions as Dict[]) || []) {
      if (!isObj(action)) continue;
      const mock_key = actionMockKey(action);
      if (!mock_key) continue;
      const schema = actionSchema(action);
      actions.push({
        action_type: action.action_type || "",
        mock_key,
        description: actionDescription(action),
        schema_json: schema ? stableStringify(schema) : "",
      });
    }
    if (actions.length > 0) {
      const meta = isObj(data.meta) ? data.meta : {};
      result.push({ node_uuid: node.id, node_name: config.name || meta.name || node.id, actions });
    }
  }
  return result;
}

// The builder canvas keeps outbound screening as a composite (no initiate_call node until save
// expansion), so the composite and the standalone screening node both mark a flow outbound.
const OUTBOUND_CALL_NODE_TYPES = new Set(["initiate_call", "outbound_screening", "contact_screening"]);

export function flowHasOutboundCall(flow: Dict): boolean {
  return ((flow.nodes as Dict[]) || []).some((n) => isObj(n) && OUTBOUND_CALL_NODE_TYPES.has(n.type as string));
}

export function extractStartNodePayloadKeys(flow: Dict): string[] {
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node) || node.type !== "start") continue;
    const config = nodeConfig(node);
    const payloadFormat = isObj(config.payload_format) ? config.payload_format : {};
    return Object.keys(payloadFormat);
  }
  return [];
}
