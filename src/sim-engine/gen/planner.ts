import { completeJSON, type LlmProvider, type LlmUsage } from "../../llm/index.js";
import { PlannerOutputZ } from "./schemas.js";
import { plannerSystemPrompt } from "./prompts.js";
import { buildFlowInventory, type MechanicalInventory } from "./inventory.js";
import { EXECUTABLE_NODE_TYPES, SUPPORTED_TERMINAL_NODE_TYPES, BLOCKED_NODE_TYPES, CONVERSATION_PATTERNS, PLANNER_MAX_OUTPUT_TOKENS, MAX_EXISTING_SCENARIO_SUMMARIES } from "./combos.js";
import type { PlannerWithInventory, ExistingScenarioSummary, SimulationMode } from "./types.js";
import { slug } from "./text.js";

// AO Simulation Engine — PLANNER (LLM 1) + deterministic fallback (Phase 1.3).
// Faithful port of the orchestrator service `_plan_capabilities` + `_fallback_planner`. The planner
// proposes capabilities (loose schema); the fallback synthesizes them from the route
// inventory when the LLM has none.

type Dict = Record<string, any>;
const sortedArr = (s: Iterable<string>) => [...s].sort();

/** Build the user payload sent to the planner LLM (mirrors `_plan_capabilities`). */
export function buildPlannerPayload(
  flowJson: Dict,
  inventory: MechanicalInventory,
  phloUuid: string,
  existingSummaries: ExistingScenarioSummary[],
  userInstructions: string,
  mode: SimulationMode,
  smokeCap?: number,
): Dict {
  const payload: Dict = {
    phlo_uuid: phloUuid,
    flow_json: flowJson,
    mechanical_inventory: inventory,
    simulation_surface: {
      executable_node_types: sortedArr(EXECUTABLE_NODE_TYPES),
      supported_terminal_node_types: sortedArr(SUPPORTED_TERMINAL_NODE_TYPES),
      blocked_node_types: sortedArr(BLOCKED_NODE_TYPES),
      routes: inventory.routes,
    },
    conversation_pattern_library: Object.keys(CONVERSATION_PATTERNS).sort(),
    existing_scenario_summaries: existingSummaries.slice(0, MAX_EXISTING_SCENARIO_SUMMARIES),
    user_instructions: userInstructions || "",
    simulation_mode: mode,
  };
  if (mode === "smoke") payload.smoke_cap = smokeCap ?? 0;
  return payload;
}

export interface PlanCapabilitiesArgs {
  /** Canonical flow (output of normalizeFlow). */
  flowJson: Dict;
  phloUuid: string;
  model: string;
  existingSummaries?: ExistingScenarioSummary[];
  userInstructions?: string;
  simulationMode?: SimulationMode;
  smokeCap?: number;
  /** Test injection — when set, completeJSON uses this instead of the real provider. */
  provider?: LlmProvider;
}

/** LLM 1: flow → capabilities (loose; json_object + Zod validation). Attaches the
 *  mechanical inventory the allocator consumes. */
export async function planCapabilities(
  args: PlanCapabilitiesArgs,
): Promise<{ planner: PlannerWithInventory; usage: LlmUsage }> {
  const mode = args.simulationMode ?? "stress";
  const inventory = buildFlowInventory(args.flowJson);
  const payload = buildPlannerPayload(
    args.flowJson,
    inventory,
    args.phloUuid,
    args.existingSummaries ?? [],
    args.userInstructions ?? "",
    mode,
    args.smokeCap,
  );
  const res = await completeJSON({
    schema: PlannerOutputZ,
    role: "generator",
    model: args.model,
    system: plannerSystemPrompt(mode, args.smokeCap ?? 0),
    prompt: JSON.stringify(payload),
    maxTokens: PLANNER_MAX_OUTPUT_TOKENS,
    provider: args.provider,
  });
  const planner = { ...res.data, mechanical_inventory: inventory } as PlannerWithInventory;
  return { planner, usage: res.usage };
}

/**
 * Deterministic fallback planner — one capability per non-blocked route, or a single
 * generic capability if the flow has no routes. Mirrors `_fallback_planner`.
 */
export function fallbackPlanner(flowJson: Dict): PlannerWithInventory {
  const inventory = buildFlowInventory(flowJson);
  const actionAnchors = inventory.actions.map((a) => a.mock_key).filter(Boolean);
  const variableAnchors = inventory.variables.map((v) => v.variable_name).filter(Boolean);

  const capabilities = inventory.routes
    .filter((route) => route.support !== "blocked")
    .map((route, idx) => {
      const intent = route.intent_name || `route_${idx + 1}`;
      const capId = slug(`handle_${intent}`) || `capability_${idx + 1}`;
      return {
        capability_id: capId,
        name: intent,
        description: route.intent_instructions || `Handle ${intent}`,
        priority: "core" as const,
        risk: "medium" as const,
        source_signals: [route.source_node_name],
        success_criteria: [`Agent routes via intent ${intent}`],
        route_anchors: [
          {
            source_node_id: route.source_node_id,
            intent_name: intent,
            target_node_type: route.target_node_type,
            support: (route.support || "fully_executable") as "fully_executable" | "supported_terminal" | "blocked",
          },
        ],
        action_anchors: actionAnchors,
        variable_anchors: variableAnchors,
        recommended_conversation_patterns: [],
        boundary_patterns: [],
        smoke_units: [],
      };
    });

  if (capabilities.length === 0) {
    capabilities.push({
      capability_id: "general_conversation",
      name: "General conversation",
      description: "Exercise the primary agent conversation.",
      priority: "core" as const,
      risk: "medium" as const,
      source_signals: ["fallback"],
      success_criteria: ["Agent handles the caller request"],
      route_anchors: [],
      action_anchors: actionAnchors,
      variable_anchors: variableAnchors,
      recommended_conversation_patterns: [],
      boundary_patterns: [],
      smoke_units: [],
    });
  }

  return {
    agent_flow_description: "Voice agent simulation flow.",
    capabilities,
    blocked_or_deferred_outcomes: [],
    planner_rationale: "Fallback planner built from route inventory.",
    mechanical_inventory: inventory,
  } as PlannerWithInventory;
}
