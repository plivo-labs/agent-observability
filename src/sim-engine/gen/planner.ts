import { completeJSON, type LlmProvider, type LlmUsage } from "../../llm/index.js";
import { PlannerOutputZ, PLANNER_SCHEMA_NAME, PLANNER_JSON_SCHEMA } from "./schemas.js";
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
    // Send text.format (loose, strict:false) so the model emits bounded structured output and
    // doesn't free-form past max_output_tokens → status="incomplete". Replicates aiassist's
    // planner exactly (PLANNER_OUTPUT_SCHEMA, strict:false); we still re-validate with Zod.
    jsonSchema: { name: PLANNER_SCHEMA_NAME, schema: PLANNER_JSON_SCHEMA, strict: false },
    provider: args.provider,
  });
  const planner = { ...res.data, mechanical_inventory: inventory } as PlannerWithInventory;
  return { planner, usage: res.usage };
}

