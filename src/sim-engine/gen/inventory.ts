import {
  BLOCKED_NODE_TYPES,
  SUPPORTED_TERMINAL_NODE_TYPES,
  EXECUTABLE_NODE_TYPES,
  OUT_OF_SCOPE_ROUTE_TERMS,
} from "./combos.js";
import { isRecord } from "../json.js";

// AO Simulation Engine — mechanical flow inventory (Phase 1.2).
//
// Faithful port of the orchestrator service `_build_flow_inventory` + helpers (scenario_generator.py
// ~L744-1051). Runs on the canonical flow produced by `normalizeFlow` (nodes with
// `data.config`, split `edges` with source/target/sourceHandle, folded `agentSettings`)
// — i.e. exactly the shape the orchestrator service's `flow_json` already has. Output feeds the PLANNER
// payload (1.3) and the allocator's route grounding (1.4). Reads dict-style + defensive,
// mirroring the Python `.get(...)` access.

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
  target_node_id: string;
  target_node_name: string;
  target_node_type: string;
  support: "fully_executable" | "supported_terminal" | "blocked";
}

export interface VariableInventoryItem {
  node_id: string;
  node_name: string;
  variable_name: string;
  variable_instructions: string;
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

export interface MechanicalInventory {
  nodes: FlowInventoryNode[];
  routes: RouteInventoryItem[];
  variables: VariableInventoryItem[];
  actions: ActionInventoryItem[];
  languages: string[];
  start_node_param_keys: string[];
  is_outbound_call: boolean;
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

function nodeConfig(node: Dict): Dict {
  const data = isObj(node.data) ? node.data : {};
  return isObj(data.config) ? data.config : {};
}

function nodeName(node: Dict): string {
  const data = isObj(node.data) ? node.data : {};
  const meta = isObj(data.meta) ? data.meta : {};
  const config = nodeConfig(node);
  return config.name || meta.name || node.id || "Unknown node";
}

function edgesBySource(flow: Dict): Record<string, Dict[]> {
  const result: Record<string, Dict[]> = {};
  for (const edge of (flow.edges as Dict[]) || []) {
    if (isObj(edge) && edge.source) {
      (result[edge.source] ??= []).push(edge);
    }
  }
  return result;
}

function supportForTargetType(targetType: string): RouteInventoryItem["support"] {
  if (BLOCKED_NODE_TYPES.has(targetType)) return "blocked";
  if (SUPPORTED_TERMINAL_NODE_TYPES.has(targetType)) return "supported_terminal";
  if (EXECUTABLE_NODE_TYPES.has(targetType)) return "fully_executable";
  return "blocked";
}

function containsOutOfScopeRouteTerm(...values: unknown[]): boolean {
  const text = values.map((v) => String(v ?? "").toLowerCase()).join(" ");
  return OUT_OF_SCOPE_ROUTE_TERMS.some((term) => text.includes(term));
}

// ── embedded action extraction (ai_agent_v2 nodes) ─────────────────────────────

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
    if (!isObj(node) || node.type !== "ai_agent_v2" || !node.id) continue;
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
      result.push({
        node_uuid: node.id,
        node_name: config.name || meta.name || node.id,
        actions,
      });
    }
  }
  return result;
}

export function flowHasOutboundCall(flow: Dict): boolean {
  return ((flow.nodes as Dict[]) || []).some((n) => isObj(n) && n.type === "initiate_call");
}

export function extractAvailableLanguages(flow: Dict): string[] {
  const agentSettings = (isObj(flow.agentSettings) && flow.agentSettings) || (isObj(flow.agent_settings) && flow.agent_settings) || {};
  const vac = isObj(agentSettings.voice_ai_config) ? agentSettings.voice_ai_config : {};
  const lang = vac.language || "";
  return lang ? [lang] : [];
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

// ── inventory builders ──────────────────────────────────────────────────────────

function extractRouteInventory(flow: Dict): RouteInventoryItem[] {
  const nodes: Record<string, Dict> = {};
  for (const node of (flow.nodes as Dict[]) || []) {
    if (isObj(node) && node.id) nodes[node.id] = node;
  }
  const bySource = edgesBySource(flow);
  const routes: RouteInventoryItem[] = [];
  for (const node of Object.values(nodes)) {
    const sourceId = node.id;
    if (!sourceId) continue;
    const config = nodeConfig(node);
    for (const intent of (config.intents as Dict[]) || []) {
      if (!isObj(intent)) continue;
      const intentId = intent.id || "";
      const intentName = intent.intent_name || intent.name || intentId || "default";
      let matchedEdge: Dict | null = null;
      for (const edge of bySource[sourceId] || []) {
        if (edge.sourceHandle === intentId || edge.sourceHandle === intentName) {
          matchedEdge = edge;
          break;
        }
      }
      const targetId = matchedEdge ? matchedEdge.target || "" : "";
      const targetNode = targetId ? nodes[targetId] || {} : {};
      const targetType = targetNode.type || "";
      let support = supportForTargetType(targetType);
      if (
        containsOutOfScopeRouteTerm(
          intentName,
          intent.intent_instructions || "",
          targetId,
          Object.keys(targetNode).length ? nodeName(targetNode) : "",
          targetType,
          matchedEdge ? matchedEdge.sourceHandle : "",
        )
      ) {
        support = "blocked";
      }
      routes.push({
        route_id: `${sourceId}:${intentName}`,
        source_node_id: sourceId,
        source_node_name: nodeName(node),
        source_node_type: node.type || "",
        intent_id: intentId,
        intent_name: intentName,
        intent_instructions: intent.intent_instructions || "",
        target_node_id: targetId,
        target_node_name: Object.keys(targetNode).length ? nodeName(targetNode) : "",
        target_node_type: targetType,
        support,
      });
    }
  }
  return routes;
}

function extractVariableInventory(flow: Dict): VariableInventoryItem[] {
  const variables: VariableInventoryItem[] = [];
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node)) continue;
    const config = nodeConfig(node);
    for (const variable of (config.extract_variables as Dict[]) || []) {
      if (!isObj(variable)) continue;
      const name = variable.variable_name || "";
      if (!name) continue;
      variables.push({
        node_id: node.id || "",
        node_name: nodeName(node),
        variable_name: name,
        variable_instructions: variable.variable_instructions || "",
      });
    }
  }
  return variables;
}

function extractActionInventory(flow: Dict): ActionInventoryItem[] {
  const actions: ActionInventoryItem[] = [];
  for (const embedded of extractEmbeddedActions(flow)) {
    for (const action of embedded.actions) {
      actions.push({
        node_id: embedded.node_uuid || "",
        node_name: embedded.node_name || "",
        mock_key: action.mock_key || "",
        action_type: action.action_type || "",
        description: action.description || "",
      });
    }
  }
  return actions;
}

/** Build the mechanical inventory from a canonical flow (output of normalizeFlow). */
export function buildFlowInventory(flow: Dict): MechanicalInventory {
  const nodes: FlowInventoryNode[] = [];
  for (const node of (flow.nodes as Dict[]) || []) {
    if (!isObj(node)) continue;
    const config = nodeConfig(node);
    nodes.push({
      id: node.id || "",
      type: node.type || "",
      name: nodeName(node),
      instructions: config.instructions || "",
      intent_names: ((config.intents as Dict[]) || [])
        .filter(isObj)
        .map((i) => i.intent_name || i.name || i.id),
      extract_variables: ((config.extract_variables as Dict[]) || [])
        .filter((v) => isObj(v) && v.variable_name)
        .map((v) => v.variable_name),
    });
  }
  return {
    nodes,
    routes: extractRouteInventory(flow),
    variables: extractVariableInventory(flow),
    actions: extractActionInventory(flow),
    languages: extractAvailableLanguages(flow),
    start_node_param_keys: extractStartNodePayloadKeys(flow),
    is_outbound_call: flowHasOutboundCall(flow),
  };
}
