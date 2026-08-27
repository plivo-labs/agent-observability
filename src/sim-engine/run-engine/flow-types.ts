// AO Simulation Engine — stop-reason wire vocabulary.
//
// The flow walk moved to agent-runner (SER-6447); AO no longer parses the graph or resolves
// edges. What survives here is the `stop_reason` string contract: agent-runner emits these
// values (mapped in schema.py:public_stop_reason), AO persists them verbatim to
// `ao_sim_run_scenario.stop_reason`, and the console labels them. `ai_not_implemented` is
// dropped — the walker never emits it.

export type StopReason =
  | "end_conversation"
  | "max_turns"
  | "unknown_intent"
  | "no_matching_edge"
  | "unsupported_node_type"
  | "error";

export const StopReasonEndConversation: StopReason = "end_conversation";
export const StopReasonMaxTurns: StopReason = "max_turns";
export const StopReasonUnknownIntent: StopReason = "unknown_intent";
export const StopReasonNoMatchingEdge: StopReason = "no_matching_edge";
export const StopReasonUnsupportedNode: StopReason = "unsupported_node_type";
export const StopReasonError: StopReason = "error";
