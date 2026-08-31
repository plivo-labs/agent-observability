import { completeJSON, type LlmProvider, type LlmUsage, type WireReasoningEffort } from "../../llm/index.js";
import { PlannerOutputZ, PLANNER_SCHEMA_NAME, PLANNER_JSON_SCHEMA } from "./schemas.js";
import { plannerSystemPrompt } from "./prompts.js";
import { containsOutOfScopeRouteTerm, type FlowInventory } from "./inventory.js";
import { routeId } from "./allocator.js";
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
  inventory: FlowInventory,
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
  /** The agent-runner mechanical inventory (fetched once per generation, threaded in). */
  inventory: FlowInventory;
  phloUuid: string;
  model: string;
  /** Reasoning effort for the planner call; `undefined` omits the parameter (the "inherit"
   *  default). Threaded from simEngineConfig by routes.ts, like `model`. */
  reasoningEffort?: WireReasoningEffort;
  /** Generation id, forwarded to the `[llm] usage` line so planner token spend can
   *  be attributed to the generation that caused it. Observational only. */
  generationId?: string;
  existingSummaries?: ExistingScenarioSummary[];
  userInstructions?: string;
  simulationMode?: SimulationMode;
  smokeCap?: number;
  /** Test injection — when set, completeJSON uses this instead of the real provider. */
  provider?: LlmProvider;
  /** Caller abort (SSE client disconnect) — stops the LLM call + its retries. */
  signal?: AbortSignal;
}

/** LLM 1: flow → capabilities (loose; json_object + Zod validation). Attaches the
 *  mechanical inventory the allocator consumes. */
export async function planCapabilities(
  args: PlanCapabilitiesArgs,
): Promise<{ planner: PlannerWithInventory; usage: LlmUsage }> {
  const mode = args.simulationMode ?? "stress";
  const inventory = args.inventory;
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
    // Split from the writer in usage accounting: both are role "generator" but they
    // have very different token profiles (one big reasoning call vs N large streamed
    // ones), so a per-role total can't attribute a cost regression to either.
    label: "planner",
    correlationId: args.generationId,
    model: args.model,
    system: plannerSystemPrompt(mode, args.smokeCap ?? 0),
    prompt: JSON.stringify(payload),
    maxTokens: PLANNER_MAX_OUTPUT_TOKENS,
    // Send text.format (loose, strict:false) so the model emits bounded structured output and
    // doesn't free-form past max_output_tokens → status="incomplete". Replicates aiassist's
    // planner exactly (PLANNER_OUTPUT_SCHEMA, strict:false); we still re-validate with Zod.
    jsonSchema: { name: PLANNER_SCHEMA_NAME, schema: PLANNER_JSON_SCHEMA, strict: false },
    // Operator-tunable reasoning effort; `undefined` (the "inherit" default) omits the parameter,
    // which is the pre-existing wire shape. Safe to raise here — unlike the judges, the planner's
    // cap (PLANNER_MAX_OUTPUT_TOKENS) is generous enough that reasoning spend can't truncate it.
    reasoningEffort: args.reasoningEffort,
    provider: args.provider,
    signal: args.signal,
  });
  const planner = { ...res.data, mechanical_inventory: inventory } as PlannerWithInventory;
  // Merge the LLM's route_anchors with the mechanical inventory (fills target_node_id/name,
  // drops out-of-scope/blocked, backfills anchor-less caps). If nothing survives, fall back to
  // route-derived capabilities so generation degrades gracefully instead of hard-failing.
  let capabilities = capabilitiesWithRoutes(planner);
  if (capabilities.length === 0) {
    capabilities = capabilitiesWithRoutes({ ...fallbackPlanner(inventory), mechanical_inventory: inventory });
  }
  const finalPlanner = { ...planner, capabilities } as unknown as PlannerWithInventory;
  return { planner: finalPlanner, usage: res.usage };
}

/**
 * Merge each capability's LLM-emitted `route_anchors` with the mechanical-inventory routes
 * (keyed by source_node_id + intent_name) so `target_node_id`/`target_node_name`/`support`
 * are populated, drop out-of-scope or blocked anchors, and backfill a capability that ends
 * with no anchors from the first executable inventory route. Faithful port of aiassist
 * `_planner_capabilities_with_routes`. Returns the enriched capability list.
 */
export function capabilitiesWithRoutes(planner: PlannerWithInventory): Dict[] {
  const invRoutes = (planner.mechanical_inventory?.routes ?? []) as unknown as Dict[];
  const byKey = new Map<string, Dict>();
  for (const r of invRoutes) byKey.set(`${r.source_node_id ?? ""} ${r.intent_name ?? ""}`, r);
  const executable = invRoutes.filter(
    (r) =>
      r.support !== "blocked" &&
      !containsOutOfScopeRouteTerm(r.route_id, r.intent_name, r.intent_instructions, r.target_node_name, r.target_node_type),
  );
  const result: Dict[] = [];
  for (const cap of (planner.capabilities ?? []) as unknown as Dict[]) {
    if (!cap || typeof cap !== "object") continue;
    if (
      containsOutOfScopeRouteTerm(
        cap.capability_id,
        cap.name,
        cap.description,
        (cap.source_signals ?? []).join(" "),
        (cap.success_criteria ?? []).join(" "),
      )
    ) {
      continue;
    }
    const anchors: Dict[] = [];
    for (const anchor of (cap.route_anchors ?? []) as Dict[]) {
      if (!anchor || typeof anchor !== "object") continue;
      const inv = byKey.get(`${anchor.source_node_id ?? ""} ${anchor.intent_name ?? ""}`);
      const merged = { ...(inv ?? {}), ...anchor }; // inventory as base so targets fill in; anchor overrides
      merged.route_id = merged.route_id || routeId(merged);
      if (
        merged.support !== "blocked" &&
        !containsOutOfScopeRouteTerm(merged.route_id, merged.intent_name, merged.intent_instructions, merged.target_node_name, merged.target_node_type)
      ) {
        anchors.push(merged);
      }
    }
    if (anchors.length === 0) anchors.push(...executable.slice(0, 1));
    if (anchors.length > 0 || executable.length === 0) {
      result.push({ ...cap, route_anchors: anchors });
    }
  }
  return result;
}

/**
 * Deterministic fallback planner — one core capability per non-blocked inventory route (or a
 * single general-conversation capability when the flow has no routes). Used when the LLM
 * planner yields no usable capabilities. Mirrors aiassist `_fallback_planner`.
 */
export function fallbackPlanner(inventory: FlowInventory): PlannerWithInventory {
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
  } as unknown as PlannerWithInventory;
}

