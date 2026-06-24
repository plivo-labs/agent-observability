import type { Capability, PlannerOutput } from "./schemas.js";
import type { MechanicalInventory } from "./inventory.js";

// AO Simulation Engine — shared pipeline types (Phase 1.3+).

export type SimulationMode = "smoke" | "stress";

export interface ExpectedRouteOutcome {
  source_node_id: string;
  expected_intent_name: string;
  target_node_id: string;
  target_node_name: string;
  target_node_type: string;
}

/** A candidate slot before selection (no slot_id / simulation_mode yet). Carries the
 *  8 allocation axes + the derived expected-outcome fields + the coverage_key. */
export interface Candidate {
  capability_id: string;
  capability_name: string;
  scenario_type: string;
  conversation_pattern_id: string;
  persona_combo_id: string;
  entity_format_combo_id: string;
  runtime_stress_combo_id: string;
  route_id: string;
  mock_profile_id: string;
  expected_business_outcome: string;
  expected_route_outcome: ExpectedRouteOutcome;
  required_mocked_actions: string[];
  variable_anchors: string[];
  coverage_key: string;
}

/** A selected slot — a Candidate plus slot_id + simulation_mode (+ smoke fields). */
export interface Slot extends Candidate {
  slot_id: string;
  simulation_mode: SimulationMode;
  smoke_unit_id?: string;
  smoke_unit_kind?: string;
  smoke_unit_description?: string;
  smoke_units_hash?: string;
}

export interface EvalMetadata {
  generation_id: string;
  slot_id: string;
  capability_id: string;
  scenario_type: string;
  conversation_pattern_id: string;
  persona_combo_id: string;
  entity_format_combo_id: string;
  runtime_stress_combo_id: string;
  mock_profile_id: string;
  route_id: string;
  coverage_key: string;
  expected_business_outcome?: string;
  expected_route_outcome?: ExpectedRouteOutcome;
  required_mocked_actions: string[];
  variable_anchors: string[];
  simulation_mode: string;
  smoke_unit_id?: string;
  smoke_unit_kind?: string;
  smoke_unit_description?: string;
  smoke_units_hash?: string;
}

export interface RuntimePersona {
  personality: string;
  emotional_state: string;
  behavioral_traits: string[];
  details: Record<string, unknown>;
}

export interface WorldStateRuntimeEntry {
  outcome?: string;
  data?: Record<string, unknown>;
  action_mocks?: Record<string, unknown>;
}

/** A scenario after validate_and_fix — world_state is a DICT keyed by node_id. */
export interface RuntimeScenario {
  id: string;
  name: string;
  persona: RuntimePersona;
  goal: string;
  language: string;
  world_state: Record<string, WorldStateRuntimeEntry>;
  start_node_params: Record<string, unknown>;
  interruption: { enabled: boolean; probability: number };
  stt_noise: { enabled: boolean; severity: string };
  non_answer: { enabled: boolean; probability: number };
  tags: string[];
  eval_metadata?: EvalMetadata;
  agent_flow_description?: string;
}

/** Planner output with the mechanical inventory attached (the allocator reads it). */
export type PlannerWithInventory = PlannerOutput & { mechanical_inventory: MechanicalInventory };

/** A summarized existing scenario (input to the planner + the allocator's coverage). */
export interface ExistingScenarioSummary {
  coverage_key: string;
  capability_id: string;
  scenario_type: string;
  classification_confidence: "high" | "low";
  [k: string]: unknown;
}

/** Confidence-weighted coverage counters over existing scenarios. */
export interface ExistingCoverage {
  full: Record<string, number>;
  capability: Record<string, number>;
  capability_scenario_type: Record<string, number>;
}

export type { Capability, PlannerOutput, MechanicalInventory };
