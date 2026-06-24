// AO Simulation Engine — scenario-generator prompts (committed).
//
// Faithful STRUCTURAL paraphrase of aiassist's PLANNER + WRITER prompts — same inputs,
// same modes, same JSON output contract. The exact verbatim Plivo wording can be pasted
// in here (this file is committed now; OSS genericization is a later concern). Unit tests
// inject MockLLM, so prompt CONTENT is never asserted — only that these return a usable
// system prompt. Keep the exported function names + signatures stable (planner.ts /
// writer.ts import them).

/**
 * PLANNER (LLM 1) system prompt. Mirrors aiassist `_planner_prompt(simulation_mode,
 * smoke_cap)`: base instructions + a smoke-mode suffix capped at `smokeCap`. The user
 * payload (flow_json, mechanical_inventory, conversation_pattern_library,
 * existing_scenario_summaries, user_instructions, simulation_mode) is assembled by the
 * caller (planner.ts) — this is only the system instruction.
 */
export function plannerSystemPrompt(simulationMode: "smoke" | "stress", smokeCap = 0): string {
  const base = [
    "You are a test-coverage planner for a voice/chat agent flow.",
    "You are given the agent's flow_json and a mechanical_inventory (nodes, routes,",
    "variables, actions, languages, start_node_param_keys, is_outbound_call).",
    "",
    "Identify the distinct CAPABILITIES the agent supports — the jobs a caller can get",
    "done (happy paths), the soft boundaries (deflections, challenges), and the hard",
    "guardrails. Ground every capability in the inventory: cite route_anchors",
    "(source_node_id, intent_name, target_node_type, support), action_anchors, and",
    "variable_anchors that evidence it. Mark priority (core|secondary|boundary) and",
    "risk (high|medium|low).",
    "",
    "List outcomes that are blocked or deferred (unreachable/blocked nodes) with a",
    "reason. Give a short planner_rationale and a one-paragraph agent_flow_description.",
    "",
    "Respond with ONLY a JSON object matching the capability_planner_output schema",
    "(agent_flow_description, capabilities[], blocked_or_deferred_outcomes[],",
    "planner_rationale).",
  ].join("\n");

  if (simulationMode !== "smoke") return base;

  const smoke = [
    "",
    "SMOKE MODE: also emit `smoke_units` per capability — the minimal set of coverage",
    "units (kind happy_path|boundary, scenario_type clean_baseline|boundary_pressure,",
    "optional route_id, a short description). Each unit becomes exactly one scenario.",
    `Emit at most ${smokeCap} smoke units in total across all capabilities.`,
  ].join("\n");
  return base + "\n" + smoke;
}

/**
 * WRITER (LLM 2) system prompt. Mirrors aiassist `_writer_prompt()`. The user payload
 * (generation_id, writer_context, the slots batch, and the resolved combo_definitions)
 * is assembled by writer.ts — this is only the system instruction. Output is STRICT
 * against scenario_writer_output.
 */
export function writerSystemPrompt(): string {
  return [
    "You write concrete simulation scenarios for a voice/chat agent under test.",
    "You are given a batch of slots (each with a capability, scenario_type,",
    "conversation pattern, persona/entity/stress/mock combo ids, route, and expected",
    "outcomes) plus the RESOLVED combo definitions. Write exactly ONE scenario per",
    "slot_id; never merge, drop, or invent slots.",
    "",
    "Per scenario:",
    "- name: a 3-5 word title.",
    "- persona: a canonical lowercase `personality`, an `emotional_state`, and",
    "  `behavioral_traits` drawn ONLY from the canonical trait vocabulary (no aliases).",
    "  Put any caller-specific details in `details_json` (a JSON-encoded object; \"{}\"",
    "  if none).",
    "- goal: describe what the caller wants in natural terms — their situation and aim,",
    "  NOT a turn-by-turn script. Always non-empty.",
    "- language: a canonical language from the flow's available languages; never invent",
    "  a locale string.",
    "- world_state: an ARRAY with one entry per mockable node the route touches:",
    "  { node_id, outcome, data_json, action_mocks_json } (the *_json fields are",
    "  JSON-encoded objects; use \"{}\" if none). Empty array if no mockable nodes.",
    "- start_node_params_json: JSON-encoded start-node trigger params (\"{}\" if none).",
    "- tags: short descriptive tags.",
    "",
    "For boundary_pressure slots, probe the relevant guardrail per the conversation",
    "pattern. Respond with ONLY a JSON object matching scenario_writer_output",
    "(agent_flow_description, scenario_items[{slot_id, scenario}]).",
  ].join("\n");
}
