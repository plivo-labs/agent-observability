import { completeJSON, type LlmProvider, type LlmUsage } from "../../llm/index.js";
import { WriterOutputZ, WRITER_JSON_SCHEMA, WRITER_SCHEMA_NAME } from "./schemas.js";
import { writerSystemPrompt } from "./prompts.js";
import {
  PERSONA_COMBOS,
  RUNTIME_STRESS_COMBOS,
  CONVERSATION_PATTERNS,
  ENTITY_FORMAT_COMBOS,
  MOCK_PROFILES,
  TRAIT_ALIASES,
  TRAIT_TAGS,
  CANONICAL_TRAITS,
  OUT_OF_SCOPE_SCENARIO_TERMS,
  MOCKABLE_NODE_REGISTRY,
} from "./combos.js";
import {
  extractEmbeddedActions,
  extractAvailableLanguages,
  extractStartNodePayloadKeys,
  flowHasOutboundCall,
} from "./inventory.js";
import type { Slot, RuntimeScenario, EvalMetadata, PlannerWithInventory } from "./types.js";
import { isRecord } from "../json.js";

// AO Simulation Engine — WRITER (LLM 2) + validate_and_fix (Phase 1.5).
// Faithful port of the orchestrator service `_write_scenario_chunk`, `_combo_context_for_slots`,
// `validate_and_fix_scenario` + its helpers. The writer emits a strict schema with
// world_state as an array + *_json string blobs; validate_and_fix turns that into the
// runtime shape (dict world_state), fills defaults from the slot, and stamps eval_metadata.

type Dict = Record<string, any>;
const isObj = (v: unknown): v is Dict => isRecord(v);
const CANON = new Set<string>(CANONICAL_TRAITS);

// ── JSON-blob + shape unpacking ───────────────────────────────────────────────

function parseWriterJsonBlob(value: unknown): Dict | unknown[] {
  if (value === null || value === undefined || value === "") return {};
  if (isObj(value) || Array.isArray(value)) return value as Dict | unknown[];
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isObj(parsed) || Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Convert the writer's strict shape into the runtime shape (mutates `scenario`). */
function unpackWriterJsonFields(scenario: Dict): void {
  if (!isObj(scenario)) return;

  const ws = scenario.world_state;
  if (Array.isArray(ws)) {
    const rebuilt: Dict = {};
    for (const entry of ws) {
      if (!isObj(entry)) continue;
      const nodeId = entry.node_id;
      if (typeof nodeId !== "string" || !nodeId) continue;
      const nodeState: Dict = {};
      const outcome = entry.outcome;
      if (typeof outcome === "string" && outcome) nodeState.outcome = outcome;
      const data = parseWriterJsonBlob(entry.data_json);
      if (isObj(data) && Object.keys(data).length) nodeState.data = data;
      const actionMocks = parseWriterJsonBlob(entry.action_mocks_json);
      if (isObj(actionMocks) && Object.keys(actionMocks).length) nodeState.action_mocks = actionMocks;
      if (Object.keys(nodeState).length) rebuilt[nodeId] = nodeState;
    }
    scenario.world_state = rebuilt;
  }

  const persona = scenario.persona;
  if (isObj(persona) && "details_json" in persona) {
    const parsed = parseWriterJsonBlob(persona.details_json);
    delete persona.details_json;
    persona.details = isObj(parsed) ? parsed : {};
  }

  if ("start_node_params_json" in scenario) {
    const parsed = parseWriterJsonBlob(scenario.start_node_params_json);
    delete scenario.start_node_params_json;
    scenario.start_node_params = isObj(parsed) ? parsed : {};
  }
}

/** Keep only valid world_state entries (outcome string / data dict / action_mocks dict). */
function sanitizeWorldStateForRunner(scenario: Dict): void {
  const ws = scenario.world_state;
  if (!isObj(ws)) {
    scenario.world_state = {};
    return;
  }
  const sanitized: Dict = {};
  for (const [key, value] of Object.entries(ws)) {
    if (typeof key !== "string" || !isObj(value)) continue;
    const entry: Dict = {};
    if (typeof value.outcome === "string") entry.outcome = value.outcome;
    if (isObj(value.data)) entry.data = value.data;
    if (isObj(value.action_mocks)) entry.action_mocks = value.action_mocks;
    if (Object.keys(entry).length) sanitized[key] = entry;
  }
  scenario.world_state = sanitized;
}

// ── runtime / traits / params helpers ──────────────────────────────────────────

export function runtimeConfig(stressId: string): {
  interruption: { enabled: boolean; probability: number };
  stt_noise: { enabled: boolean; severity: string };
  non_answer: { enabled: boolean; probability: number };
} {
  const s = RUNTIME_STRESS_COMBOS[stressId] ?? RUNTIME_STRESS_COMBOS.R00;
  return {
    interruption: { enabled: !!s.interruption, probability: s.interruption ? 0.3 : 0 },
    stt_noise: { enabled: !!s.stt_noise, severity: s.stt_noise ? "medium" : "light" },
    non_answer: { enabled: !!s.non_answer, probability: s.non_answer ? 0.2 : 0 },
  };
}

/** Canonicalize via aliases, keep only canonical traits, dedup, append fallback, cap at 4. */
export function normalizeTraits(traits: string[] | undefined, fallback: string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const raw of traits ?? []) {
    const t = TRAIT_ALIASES[raw] ?? raw;
    if (CANON.has(t) && !normalized.includes(t)) normalized.push(t);
  }
  for (const t of fallback ?? []) {
    if (!normalized.includes(t)) normalized.push(t);
  }
  return normalized.slice(0, 4);
}

function containsOutOfScopeScenarioTerm(...values: unknown[]): boolean {
  const text = values.map((v) => String(v ?? "").toLowerCase()).join(" ");
  return OUT_OF_SCOPE_SCENARIO_TERMS.some((term) => text.includes(term));
}

function rejectionReasons(scenario: Dict): string[] {
  if (!isObj(scenario)) return ["scenario_not_object"];
  const reasons: string[] = [];
  if (!scenario.name) reasons.push("missing_name");
  if (!scenario.goal) reasons.push("missing_goal");
  if (containsOutOfScopeScenarioTerm(scenario.goal, scenario.name, (scenario.tags ?? []).join(" "))) {
    reasons.push("out_of_scope_telephony_scenario");
  }
  return reasons;
}

function defaultStartParamValue(key: string, scenario: Dict, slotId: string): string {
  const k = key.toLowerCase();
  const details = isObj(scenario.persona?.details) ? scenario.persona.details : {};
  if (["name", "lead_name", "student_name", "caller_name", "customer_name"].includes(k)) {
    return (
      details.student_name || details.caller_name || details.customer_name || details.name || `Test Caller ${slotId}`
    );
  }
  if (k.includes("partner")) return "Test Partner";
  if (k.includes("phone") || k.includes("number") || ["to", "to_number"].includes(k)) return "+15005550006";
  return `test_${k}_${slotId.toLowerCase()}`;
}

function ensureStartNodeParams(scenario: Dict, keys: string[], slotId: string): void {
  if (!keys || keys.length === 0) return;
  const params = isObj(scenario.start_node_params) ? scenario.start_node_params : {};
  for (const key of keys) {
    if (!(key in params) || params[key] === null || params[key] === "") {
      params[key] = defaultStartParamValue(key, scenario, slotId);
    }
  }
  scenario.start_node_params = params;
}

// ── validate_and_fix ─────────────────────────────────────────────────────────────

/**
 * Normalize a writer scenario into the runtime shape; fill defaults + stamp
 * eval_metadata from the slot. Returns null when the scenario is rejected.
 */
export function validateAndFixScenario(
  scenario: Dict,
  slot: Slot | null,
  generationId: string,
  agentFlowDescription: string,
  startNodeParamKeys: string[],
): RuntimeScenario | null {
  if (!isObj(scenario)) return null;
  unpackWriterJsonFields(scenario);
  // (_convert_decimals is a Python-only no-op in TS.)
  if (rejectionReasons(scenario).length > 0) return null;

  scenario.id = crypto.randomUUID();
  if (scenario.world_state == null) scenario.world_state = {};
  sanitizeWorldStateForRunner(scenario);
  if (scenario.start_node_params == null) scenario.start_node_params = {};
  if (scenario.tags == null) scenario.tags = [];

  const persona: Dict = isObj(scenario.persona) ? scenario.persona : {};
  scenario.persona = persona;
  if (persona.details == null) persona.details = {};

  if (slot) {
    const combo = PERSONA_COMBOS[slot.persona_combo_id] ?? ({} as Dict);
    persona.personality = persona.personality || combo.style || "natural";
    persona.emotional_state = persona.emotional_state || combo.emotional_state || "neutral";
    persona.behavioral_traits = normalizeTraits(persona.behavioral_traits, combo.behavioral_traits ?? []);

    const rc = runtimeConfig(slot.runtime_stress_combo_id);
    scenario.interruption = rc.interruption;
    scenario.stt_noise = rc.stt_noise;
    scenario.non_answer = rc.non_answer;

    const tags = new Set<string>(scenario.tags as string[]);
    tags.add(slot.scenario_type);
    tags.add(`capability:${slot.capability_id}`);
    tags.add(`pattern:${slot.conversation_pattern_id}`);
    tags.add(`persona:${slot.persona_combo_id}`);
    tags.add(`entity_format:${slot.entity_format_combo_id}`);
    tags.add(`runtime_stress:${slot.runtime_stress_combo_id}`);
    tags.add(`mock_profile:${slot.mock_profile_id}`);
    for (const trait of persona.behavioral_traits as string[]) {
      const tag = TRAIT_TAGS[trait];
      if (tag) tags.add(tag);
    }
    if (rc.interruption.enabled) tags.add("interruption");
    if (rc.stt_noise.enabled) tags.add("stt_noise");
    if (rc.non_answer.enabled) tags.add("non_answer");
    scenario.tags = [...tags].sort();

    const evalMetadata: EvalMetadata = {
      generation_id: generationId,
      slot_id: slot.slot_id,
      capability_id: slot.capability_id,
      scenario_type: slot.scenario_type,
      conversation_pattern_id: slot.conversation_pattern_id,
      persona_combo_id: slot.persona_combo_id,
      entity_format_combo_id: slot.entity_format_combo_id,
      runtime_stress_combo_id: slot.runtime_stress_combo_id,
      mock_profile_id: slot.mock_profile_id,
      route_id: slot.route_id,
      coverage_key: slot.coverage_key,
      expected_business_outcome: slot.expected_business_outcome,
      expected_route_outcome: slot.expected_route_outcome,
      required_mocked_actions: slot.required_mocked_actions ?? [],
      variable_anchors: slot.variable_anchors ?? [],
      simulation_mode: slot.simulation_mode || "stress",
    };
    if (slot.smoke_unit_id) {
      evalMetadata.smoke_unit_id = slot.smoke_unit_id;
      evalMetadata.smoke_unit_kind = slot.smoke_unit_kind || "";
      evalMetadata.smoke_unit_description = slot.smoke_unit_description || "";
      evalMetadata.smoke_units_hash = slot.smoke_units_hash || "";
    }
    scenario.eval_metadata = evalMetadata;

    if (slot.simulation_mode === "smoke") {
      const t2 = new Set<string>(scenario.tags as string[]);
      t2.add("simulation_mode:smoke");
      if (slot.smoke_unit_kind) t2.add(`smoke_kind:${slot.smoke_unit_kind}`);
      scenario.tags = [...t2].sort();
    }

    ensureStartNodeParams(scenario, startNodeParamKeys, slot.slot_id);
  } else {
    const interruption: Dict = isObj(scenario.interruption) ? scenario.interruption : {};
    if (interruption.enabled && (interruption.probability || 0) <= 0) interruption.probability = 0.3;
    if (!isObj(scenario.interruption)) scenario.interruption = { enabled: false, probability: 0 };

    const sttNoise: Dict = isObj(scenario.stt_noise) ? scenario.stt_noise : {};
    if (sttNoise.enabled && !sttNoise.severity) sttNoise.severity = "medium";
    if (!isObj(scenario.stt_noise)) scenario.stt_noise = { enabled: false, severity: "light" };

    const nonAnswer: Dict = isObj(scenario.non_answer) ? scenario.non_answer : {};
    if (nonAnswer.enabled && (nonAnswer.probability || 0) <= 0) nonAnswer.probability = 0.2;
    if (!isObj(scenario.non_answer)) scenario.non_answer = { enabled: false, probability: 0 };
  }

  if (agentFlowDescription) scenario.agent_flow_description = agentFlowDescription;
  return scenario as RuntimeScenario;
}

// ── writer chunk ─────────────────────────────────────────────────────────────────

/** Resolve the combo ids present in a slot batch to their definitions (for the writer). */
export function comboContextForSlots(slots: Slot[]): Dict {
  const pick = <T>(ids: string[], lib: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const id of ids) if (id in lib) out[id] = lib[id];
    return out;
  };
  return {
    personas: pick(slots.map((s) => s.persona_combo_id), PERSONA_COMBOS),
    entity_formats: pick(slots.map((s) => s.entity_format_combo_id), ENTITY_FORMAT_COMBOS),
    runtime_stress: pick(slots.map((s) => s.runtime_stress_combo_id), RUNTIME_STRESS_COMBOS),
    mock_profiles: pick(slots.map((s) => s.mock_profile_id), MOCK_PROFILES),
    conversation_patterns: pick(slots.map((s) => s.conversation_pattern_id), CONVERSATION_PATTERNS),
  };
}

function findMockableTypesInFlow(flowJson: Dict): Dict[] {
  const seen = new Set<string>();
  const out: Dict[] = [];
  for (const node of (flowJson.nodes as Dict[]) || []) {
    const t = node?.type ?? "";
    if (t in MOCKABLE_NODE_REGISTRY && !seen.has(t)) {
      seen.add(t);
      out.push(MOCKABLE_NODE_REGISTRY[t]);
    }
  }
  return out;
}

export interface WriteScenarioChunkArgs {
  flowJson: Dict;
  planner: PlannerWithInventory;
  slots: Slot[];
  model: string;
  generationId: string;
  phloUuid: string;
  chunkIndex: number;
  attempt: number;
  provider?: LlmProvider;
}

export interface WriteScenarioChunkResult {
  scenarios: RuntimeScenario[];
  usage: LlmUsage;
  failedSlotIds: string[];
  validationErrors: Array<{ slot_id: string; reasons: string[] }>;
}

/** LLM 2: a batch of ≤WRITER_CHUNK_SIZE slots → validated scenarios. */
export async function writeScenarioChunk(args: WriteScenarioChunkArgs): Promise<WriteScenarioChunkResult> {
  const { flowJson, planner, slots, model, generationId } = args;
  const startNodeParamKeys = extractStartNodePayloadKeys(flowJson);

  const payload: Dict = {
    generation_id: generationId,
    writer_context: {
      agent_flow_description: planner.agent_flow_description,
      nodes: flowJson.nodes ?? [],
      embedded_actions: extractEmbeddedActions(flowJson),
      mockable_types: findMockableTypesInFlow(flowJson),
      available_languages: extractAvailableLanguages(flowJson),
      start_node_param_keys: startNodeParamKeys,
      is_outbound_call: flowHasOutboundCall(flowJson),
      planner_rationale: planner.planner_rationale,
    },
    slots,
    expected_scenario_count: slots.length,
    expected_slot_ids: slots.map((s) => s.slot_id),
    combo_definitions: comboContextForSlots(slots),
  };

  const res = await completeJSON({
    schema: WriterOutputZ,
    role: "generator",
    model,
    system: writerSystemPrompt(),
    prompt: JSON.stringify(payload),
    // Stream with NO output cap (maxTokens:null) — a batch of 10 scenarios on a reasoning model
    // overruns any fixed cap and returns status="incomplete". This is aiassist's exact primary
    // writer path (_stream_scenario_writer: stream:true, no max_output_tokens).
    stream: true,
    maxTokens: null,
    jsonSchema: { name: WRITER_SCHEMA_NAME, schema: WRITER_JSON_SCHEMA },
    provider: args.provider,
  });

  const slotById = new Map(slots.map((s) => [s.slot_id, s]));
  const scenarios: RuntimeScenario[] = [];
  const failedSlotIds: string[] = [];
  const validationErrors: Array<{ slot_id: string; reasons: string[] }> = [];
  const seen = new Set<string>();

  for (const item of res.data.scenario_items) {
    const slotId = item.slot_id;
    const slot = slotById.get(slotId);
    if (!slot || seen.has(slotId)) continue;
    const fixed = validateAndFixScenario(
      item.scenario as Dict,
      slot,
      generationId,
      res.data.agent_flow_description,
      startNodeParamKeys,
    );
    if (!fixed) {
      failedSlotIds.push(slotId);
      validationErrors.push({ slot_id: slotId, reasons: rejectionReasons(item.scenario as Dict) });
      continue;
    }
    scenarios.push(fixed);
    seen.add(slotId);
  }
  for (const s of slots) if (!seen.has(s.slot_id) && !failedSlotIds.includes(s.slot_id)) failedSlotIds.push(s.slot_id);

  return { scenarios, usage: res.usage, failedSlotIds, validationErrors };
}
