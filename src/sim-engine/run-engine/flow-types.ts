// AO Simulation Engine — FlowGraph executor types.
//
// Faithful port of the reference worker `usecases/simulation_eval/flow_types.go`
// (plus the minimal `VariableStore` from `variable_renderer.go` and
// `WorldStateEntry` from `models.go` that the orchestrator depends on).
//
// These types are PURE — no Redis, DB, or HTTP. The `AINodeExecutor`
// interface is the only seam to the outside world: the concrete impl
// (UserSimulator + the /turn client) is wired later in Stage 6.

// The full VariableStore (set + render + get + flattenToStringMap) lives in variable-renderer.ts.
// The orchestrator only calls `set`, but the AI-node executor passes the SAME store to
// buildAgentConfig (which needs render/flattenToStringMap) — so the engine shares exactly ONE
// VariableStore. Imported here for the AINodeExecutor interface + re-exported for flow-executor.
import { VariableStore } from "./variable-renderer.js";
export { VariableStore };

/** A node in the parsed flow graph. `config` is `data.config`; `data` is the full `node.data`. */
export interface FlowNode {
  id: string;
  type: string;
  /** from data.config.name */
  configName: string;
  /** from data.meta.name */
  metaName: string;
  /** from data.config — null when the node carries no config object */
  config: Record<string, unknown> | null;
  /** full node.data — null when the node carries no data object */
  data: Record<string, unknown> | null;
}

/** A directed edge. `sourceHandle` is matched against the executing node's outcome. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  data: Record<string, unknown> | null;
}

/** Parsed flow: nodes by id, all edges, outgoing edges by source node id, and the start node id. */
export interface FlowGraph {
  /** nodeID → node */
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
  /** source nodeID → outgoing edges */
  nodeEdges: Map<string, FlowEdge[]>;
  startNodeId: string;
}

/**
 * Why the orchestrator stopped. EXACT string values from the Go
 * `StopReason` consts — a parity test diffs these against the worker.
 */
export type StopReason =
  | "end_conversation"
  | "max_turns"
  | "unknown_intent"
  | "no_matching_edge"
  | "unsupported_node_type"
  | "ai_not_implemented"
  | "error";

// Named constants mirroring the Go consts, so callers can reference them
// symbolically instead of repeating string literals.
export const StopReasonEndConversation: StopReason = "end_conversation";
export const StopReasonMaxTurns: StopReason = "max_turns";
export const StopReasonUnknownIntent: StopReason = "unknown_intent";
export const StopReasonNoMatchingEdge: StopReason = "no_matching_edge";
export const StopReasonUnsupportedNode: StopReason = "unsupported_node_type";
export const StopReasonAINotImplemented: StopReason = "ai_not_implemented";
export const StopReasonError: StopReason = "error";

/** Result of executing a single node. `outcome` is the sourceHandle used for edge resolution. */
export interface NodeExecutionResult {
  /** sourceHandle for edge resolution */
  outcome: string;
  /** extracted variables for downstream rendering */
  variables: Record<string, unknown>;
  /** agent/action response message */
  message: string;
}

/**
 * Final orchestrator outcome. Shape mirrors the Go `OrchestratorResult`
 * struct's JSON tags exactly (snake_case keys; `errorDetail` is omitted
 * when empty, like Go's `omitempty`).
 */
export interface OrchestratorResult {
  stop_reason: StopReason | "";
  nodes_visited: string[];
  last_node_id: string;
  last_node_type: string;
  turn_count: number;
  error_detail?: string;
}

/**
 * The single seam to the outside world. The orchestrator calls this to
 * execute an `ai_agent_v2` node. The concrete impl (UserSimulator + the
 * /turn client) is wired later in Stage 6 — NOT defined here.
 *
 * Contract: returns a `NodeExecutionResult` on success. Returning
 * `null`/`undefined` without throwing is a contract violation the
 * orchestrator surfaces as `StopReasonError` (mirrors the Go nil-result
 * guard). Throwing yields `StopReasonError` with the error message.
 */
export interface AINodeExecutor {
  executeAINode(
    node: FlowNode,
    turnIndex: number,
    variableStore: VariableStore,
  ): Promise<NodeExecutionResult | null>;
}

/**
 * A mocked non-AI node's pre-seeded outcome + variables, keyed in
 * world_state by node ID or config name. Mirrors the Go `WorldStateEntry`.
 */
export interface WorldStateEntry {
  /** "success", "error", "failed", … — empty falls back to the node-type default. */
  outcome?: string;
  data?: Record<string, unknown> | null;
  actionMocks?: Record<string, unknown> | null;
}

// (VariableStore is imported + re-exported from variable-renderer.ts at the top of this file.)
