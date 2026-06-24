// AO Simulation Engine — buildAgentConfig (the per-turn LiveKit agent_config payload).
//
// Port of cx-sqs-worker `usecases/simulation_eval/scenario_runner.go` `buildAgentConfig`
// (L519-557). Each AI turn the engine builds the `agent_config` object livekit's /turn
// endpoint runs the CXAgent against: the node's own config (deep-copied), plus flow-level
// data hoisted in — global_prompt, voice_config, stt_guidance — and the variable store
// flattened into `all_node_vars`. `{{Node.var}}` references in the node's `instructions`
// are rendered against the variable store before sending.
//
// The handoff plan (`output_state_config`) is attached by the CALLER (the ScenarioRunner
// port) after this returns — not here — exactly as the Go does
// (`agentConfig["output_state_config"] = handoffPlan`).

import type { VariableStore } from "./variable-renderer.js";
import { isRecord, deepCopyMap } from "../json.js";

/** The node fields buildAgentConfig reads. Structurally compatible with the handoff
 *  planner's node and with cx-sqs-worker's FlowNode (id / type / config / configName). */
export interface AgentConfigNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  configName: string;
}

/**
 * Build the `agent_config` payload for livekit from the flow node's config, augmented with
 * rendered instructions, global_prompt, voice_config, stt_guidance, and all_node_vars.
 *
 * Faithful to the Go field-for-field:
 *   1. agent_config = deep copy of node.config.
 *   2. If `instructions` is a string, render `{{Node.var}}` refs against the variable store.
 *   3. From flowConfig (the camelCase flow JSON):
 *        - systemPrompt.prompt        → agent_config.global_prompt
 *        - agentSettings.voice_ai_config → agent_config.voice_config
 *        - global_meta.stt_guidance   → agent_config.stt_guidance (only when non-empty)
 *   4. agent_config.all_node_vars = variableStore.flattenToStringMap().
 *   5. Default agent_config.variables to [] when absent.
 *
 * KNOWN GAP (preserved from the Go): the worker's CLAUDE.md step 3 says buildAgentConfig
 * "Preserves knowledge_base_ids; LiveKit simulation performs real read-only KB lookup",
 * but the actual Go `buildAgentConfig` does NOT hoist flow-level
 * `agentSettings.knowledge_base_ids` into agent_config — it only injects global_prompt /
 * voice_config / stt_guidance. Any `knowledge_base_ids` already on the NODE's config
 * survives via the deep copy, but the flow-level list is dropped. We mirror that gap
 * exactly for parity; do NOT "fix" it here without a matching change in the worker, or
 * the parity diff breaks. TODO(parity): hoist agentSettings.knowledge_base_ids once the
 * worker does, then update both sides together.
 */
export function buildAgentConfig(
  node: AgentConfigNode,
  variableStore: VariableStore,
  flowConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const agentConfig = deepCopyMap(node.config);

  // 2. Render {{Node.var}} in instructions (only when it's actually a string).
  if (typeof agentConfig["instructions"] === "string") {
    agentConfig["instructions"] = variableStore.render(agentConfig["instructions"] as string);
  }

  // 3. Hoist flow-level data. Each lookup mirrors the Go's nested type assertions —
  // a missing/wrong-typed level is simply skipped (no throw, no default key).
  if (flowConfig) {
    const sp = flowConfig["systemPrompt"];
    if (isRecord(sp) && typeof sp["prompt"] === "string") {
      agentConfig["global_prompt"] = sp["prompt"];
    }
    const as = flowConfig["agentSettings"];
    if (isRecord(as)) {
      const vac = as["voice_ai_config"];
      if (isRecord(vac)) agentConfig["voice_config"] = vac;
    }
    const gm = flowConfig["global_meta"];
    if (isRecord(gm)) {
      const stt = gm["stt_guidance"];
      if (typeof stt === "string" && stt !== "") agentConfig["stt_guidance"] = stt;
    }
  }

  // 4. all_node_vars — how livekit sees upstream variables.
  agentConfig["all_node_vars"] = variableStore.flattenToStringMap();

  // 5. Default `variables` to an empty array when absent (Go: `if agentConfig["variables"] == nil`).
  if (agentConfig["variables"] == null) {
    agentConfig["variables"] = [];
  }

  return agentConfig;
}
