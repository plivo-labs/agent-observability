// Single source of truth for the flow node-type taxonomy. Replaces the scattered
// classifiers that used to live in graph.ts. Cross-checked against the console
// (contacto-console flow/types.ts), the worker (cx-sqs-worker config/constants.go)
// and aiassist's scenario_generator.py classification.
//
// Design rule (from the plan): do NOT out-strict the runtime. Unknown types are
// ACCEPTED — they're classified as "unknown" and only warned about when they sit
// on a simulatable path. Nothing here ever rejects a flow.

/** A node's role in the simulation, derived purely from its `type` string. */
export type NodeKind = "agent" | "control" | "terminal" | "start" | "blocked" | "unknown";

// Node types that actually converse with the user (a transcript turn maps to one).
export const AGENT_TYPES = new Set<string>([
  "ai_agent_v2",
  "ai_agent_call",
  "ai_agent_chat",
  "ai_agent_message",
]);

// Control / action nodes the orchestrator MOCKS via world_state (it hops through
// them, taking the mocked outcome edge — they never run for real in a simulation).
export const CONTROL_MOCKABLE_TYPES = new Set<string>([
  "branch_v2",
  "http_request",
  "ai_action",
  "initiate_call",
  "prompt",
  "get_input",
  "business_hour",
  "counter",
]);

// Node types that end the conversation.
export const TERMINAL_TYPES = new Set<string>(["end_conversation", "call_forward", "hangup"]);

// The flow entry point.
export const START_TYPES = new Set<string>(["start"]);

// Known-but-unsupported types: accepted (no crash) but mocked through with a
// warning when reachable. `ai_agent_whatsapp` is an agent on the real platform
// but the simulator can't drive a WhatsApp surface, so it's blocked here.
export const BLOCKED_TYPES = new Set<string>(["queue_and_route", "ai_agent_whatsapp"]);

/** Does this node type converse with the user (own a transcript turn)? */
export function isAgentNode(type: string): boolean {
  return AGENT_TYPES.has(type);
}

/** Does this node type end the conversation? */
export function isTerminalNode(type: string): boolean {
  return TERMINAL_TYPES.has(type);
}

/** Is this the flow entry-point type? */
export function isStartNode(type: string): boolean {
  return START_TYPES.has(type);
}

/** Known-but-unsupported in simulation (mocked through with a warning). */
export function isBlockedNode(type: string): boolean {
  return BLOCKED_TYPES.has(type);
}

/**
 * Classify a node type into its simulation role. Order matters: a type that
 * appears in two sets (shouldn't happen with the sets above) resolves to the
 * first match here. Anything outside every known set is `"unknown"` — accepted
 * by the schema/normalizer and only surfaced as a warning by the validator when
 * it sits on a path the simulation would actually walk.
 */
export function classifyNodeType(type: string): NodeKind {
  if (AGENT_TYPES.has(type)) return "agent";
  if (TERMINAL_TYPES.has(type)) return "terminal";
  if (START_TYPES.has(type)) return "start";
  if (BLOCKED_TYPES.has(type)) return "blocked";
  if (CONTROL_MOCKABLE_TYPES.has(type)) return "control";
  return "unknown";
}
