import {
  CONVERSATION_PATTERNS,
  SCENARIO_TYPE_DEFAULT_PATTERNS,
  PRIORITY_WEIGHT,
  RISK_WEIGHT,
} from "./combos.js";
import { createHash } from "node:crypto"; // deterministic builtin (units hash) — the config-free contract holds
import type { Capability, SmokeUnit } from "./schemas.js";
import type { Slot, PlannerWithInventory } from "./types.js";
import { slug } from "./text.js"; // pure leaf — keeps the allocator config-free (no planner/llm/config)
import {
  cmpStr,
  routeId,
  coverageKey,
  patternsForScenarioType,
  personaIdsForPattern,
  type AllocationResult,
  type ScenarioTypeQuotas,
} from "./allocator.js";

// AO Simulation Engine — SMOKE-mode slot allocator.
//
// Byte-faithful port of the orchestrator service's smoke allocator
// (scenario_generator.py: _flatten_smoke_units / _smoke_fallback_units_from_planner /
// _smoke_units_hash / _smoke_unit_priority_key / _smoke_route_from_unit /
// _mode_quotas_smoke / audit_smoke_allocation / allocate_smoke_slots).
//
// Smoke = the Vibe-Agent build-loop mode: ONE minimal scenario per planner-emitted
// smoke unit — happy-path jobs (clean_baseline) + guardrail checks (boundary_pressure),
// always R00 runtime (no interruptions/noise) + M_SUCCESS mocks. No candidate
// enumeration, no greedy optimizer: the planner's units ARE the allocation; the cap
// drops lowest-priority overflow. Deterministic like the stress path (total-order
// sort, sha256 hash). Pure: no LLM, no config, no DB — same contract as allocator.ts.

type Dict = Record<string, any>;

/** A smoke unit enriched with its parent capability's context (port of the
 *  dict `_flatten_smoke_units` builds — the allocator needs the capability's
 *  patterns/anchors/priority to place the unit). */
export interface EnrichedSmokeUnit extends SmokeUnit {
  capability_id: string;
  capability_name: string;
  capability_priority: string;
  capability_risk: string;
  action_anchors: string[];
  variable_anchors: string[];
  recommended_patterns: string[];
  boundary_patterns: string[];
  route_anchors: Dict[];
}

/** The capability-context enrichment shared by the flatten + fallback paths (one
 *  TS-only helper for the block the Python reference duplicates verbatim at
 *  scenario_generator.py:2118-2140 / :2175-2205 — deliberate layout divergence).
 *  `defaultPriority` differs on purpose (reference parity: :2130 vs :2197): a
 *  fallback unit is its capability's ONLY smoke coverage, so it defaults to "core"
 *  to survive cap-overflow ordering; planner-emitted units default to "secondary".
 *  Inert today (CapabilityZ requires priority) but load-bearing if that loosens. */
function capabilityContext(cap: Capability, capId: string, defaultPriority: "secondary" | "core") {
  const routeAnchors: Dict[] = cap.route_anchors ?? [];
  return {
    capability_id: capId,
    capability_name: cap.name || capId,
    capability_priority: cap.priority || defaultPriority,
    capability_risk: cap.risk || "medium",
    action_anchors: cap.action_anchors ?? [],
    variable_anchors: cap.variable_anchors ?? [],
    recommended_patterns: cap.recommended_conversation_patterns ?? [],
    boundary_patterns: cap.boundary_patterns ?? [],
    route_anchors: routeAnchors,
  };
}

/** Pull smoke_units out of each capability and attach capability context.
 *  Units without a `unit_id` are skipped (planner contract violation); uniqueness
 *  of unit_id is the planner's job and re-checked by the smoke audit. */
export function flattenSmokeUnits(planner: PlannerWithInventory): EnrichedSmokeUnit[] {
  const units: EnrichedSmokeUnit[] = [];
  for (const cap of planner.capabilities ?? []) {
    if (!cap || typeof cap !== "object") continue;
    // Same key derivation as the stress quotas/candidates/audit (slug fallback for
    // an empty capability_id) so smoke slots share the capability namespace.
    const capId = cap.capability_id || slug(cap.name || "capability");
    for (const unit of cap.smoke_units ?? []) {
      if (!unit || typeof unit !== "object" || !unit.unit_id) continue;
      units.push({ ...unit, ...capabilityContext(cap, capId, "secondary") });
    }
  }
  return units;
}

/** If the planner forgot smoke_units entirely, synthesize one clean happy-path
 *  unit per non-blocked capability (`{capId}__happy_path__001`). */
export function smokeFallbackUnits(planner: PlannerWithInventory): EnrichedSmokeUnit[] {
  const fallback: EnrichedSmokeUnit[] = [];
  for (const cap of planner.capabilities ?? []) {
    if (!cap || typeof cap !== "object") continue;
    const capId = cap.capability_id || slug(cap.name || "capability");
    if (!capId) continue;
    const context = capabilityContext(cap, capId, "core");
    const firstRoute =
      context.route_anchors.length && typeof context.route_anchors[0] === "object" ? context.route_anchors[0] : {};
    if (firstRoute.support === "blocked") continue;
    fallback.push({
      unit_id: `${capId}__happy_path__001`,
      kind: "happy_path",
      scenario_type: "clean_baseline",
      route_id: firstRoute.route_id || routeId(firstRoute),
      description: `Fallback smoke unit for ${capId}`,
      ...context,
    });
  }
  return fallback;
}

/** Stable hash over the sorted unit_ids (sha256, first 32 hex chars) — lets the
 *  Vibe Agent detect smoke-coverage drift across regenerations. Only unit_ids
 *  participate, so the hash survives re-planning as long as the same id set does. */
export function smokeUnitsHash(units: Array<{ unit_id?: string }>): string {
  const sortedIds = units.map((u) => u.unit_id || "").sort(cmpStr);
  return createHash("sha256").update(sortedIds.join("|"), "utf-8").digest("hex").slice(0, 32);
}

/** Total-order comparator: highest capability priority first, then risk, then
 *  happy_path before boundary, then capability_id, then unit_id — so cap-driven
 *  overflow drops the lowest-priority units. */
function compareSmokeUnitPriority(a: EnrichedSmokeUnit, b: EnrichedSmokeUnit): number {
  const pa = PRIORITY_WEIGHT[a.capability_priority] ?? 1.0;
  const pb = PRIORITY_WEIGHT[b.capability_priority] ?? 1.0;
  if (pa !== pb) return pb - pa;
  const ra = RISK_WEIGHT[a.capability_risk] ?? 0.0;
  const rb = RISK_WEIGHT[b.capability_risk] ?? 0.0;
  if (ra !== rb) return rb - ra;
  const ka = (a.kind || "happy_path") === "happy_path" ? 0 : 1;
  const kb = (b.kind || "happy_path") === "happy_path" ? 0 : 1;
  if (ka !== kb) return ka - kb;
  if (a.capability_id !== b.capability_id) return cmpStr(a.capability_id, b.capability_id);
  return cmpStr(a.unit_id || "", b.unit_id || "");
}

/** Resolve the unit's route: a pinned route_id is matched against the capability's
 *  route_anchors; otherwise the first anchor; otherwise a stub. */
function smokeRouteFromUnit(unit: EnrichedSmokeUnit): Dict {
  const requestedRouteId = unit.route_id || "";
  const anchors = unit.route_anchors; // non-optional — both producers always set it
  for (const anchor of anchors) {
    if (!anchor || typeof anchor !== "object") continue;
    const anchorRouteId = anchor.route_id || routeId(anchor);
    if (anchorRouteId === requestedRouteId) return anchor;
  }
  if (anchors.length && typeof anchors[0] === "object") return anchors[0];
  return { route_id: requestedRouteId, source_node_id: "", intent_name: "", target_node_type: "" };
}

/** Smoke quotas mirror the actual unit count per scenario_type — descriptive, not a
 *  target (contrast stress, where quotas drive the optimizer). messy/recovery are
 *  stress-only and always 0 in smoke. */
export function modeQuotasSmoke(units: Array<{ scenario_type?: string }>): ScenarioTypeQuotas {
  let clean = 0;
  let boundary = 0;
  for (const u of units) {
    if (u.scenario_type === "clean_baseline") clean += 1;
    else if (u.scenario_type === "boundary_pressure") boundary += 1;
  }
  return { clean_baseline: clean, messy_success: 0, recovery_success: 0, boundary_pressure: boundary };
}

export interface SmokeAuditResult {
  valid: boolean;
  actual_slots: number;
  smoke_cap: number;
  invalid_runtime_stress: string[];
  invalid_mock_profiles: string[];
  invalid_scenario_types: string[];
  duplicate_unit_ids: string[];
}

/** The four smoke invariants: R00 runtime, M_SUCCESS mocks, a smoke-legal
 *  scenario_type, no duplicate smoke_unit_id — and slot count within the cap.
 *  (Dropped over-cap units are expected; the audit does NOT require full coverage
 *  of the original unit list.) */
export function auditSmokeAllocation(slots: Slot[], smokeCap: number): SmokeAuditResult {
  const invalidRuntime: string[] = [];
  const invalidMocks: string[] = [];
  const invalidTypes: string[] = [];
  const duplicateUnits: string[] = [];
  const seenUnitIds = new Set<string>();
  for (const slot of slots) {
    if (slot.runtime_stress_combo_id !== "R00") invalidRuntime.push(slot.slot_id);
    if (slot.mock_profile_id !== "M_SUCCESS") invalidMocks.push(slot.slot_id);
    if (slot.scenario_type !== "clean_baseline" && slot.scenario_type !== "boundary_pressure") {
      invalidTypes.push(slot.slot_id);
    }
    const unitId = slot.smoke_unit_id || "";
    if (unitId && seenUnitIds.has(unitId)) duplicateUnits.push(unitId);
    seenUnitIds.add(unitId);
  }
  const valid =
    invalidRuntime.length === 0 &&
    invalidMocks.length === 0 &&
    invalidTypes.length === 0 &&
    duplicateUnits.length === 0 &&
    slots.length <= Math.max(smokeCap, 1);
  return {
    valid,
    actual_slots: slots.length,
    smoke_cap: smokeCap,
    invalid_runtime_stress: invalidRuntime,
    invalid_mock_profiles: invalidMocks,
    invalid_scenario_types: invalidTypes,
    duplicate_unit_ids: duplicateUnits,
  };
}

/** Same shape as the stress AllocationResult (one source of truth for the shared
 *  fields) with a smoke-specific audit + the smoke extras. */
export interface SmokeAllocationResult extends Omit<AllocationResult, "audit"> {
  audit: SmokeAuditResult;
  smoke_units_hash: string;
  dropped_unit_ids: string[];
  simulation_mode: "smoke";
  smoke_cap: number;
}

/** One slot per smoke unit; R00 runtime; M_SUCCESS mock; route fixed from the unit
 *  when pinned. The Python signature also accepts (and ignores) existing_scenarios;
 *  dropped here — smoke has no cross-batch dedup (the unit list IS the coverage
 *  contract). */
export function allocateSmokeSlots(args: { planner: PlannerWithInventory; smokeCap: number }): SmokeAllocationResult {
  const { planner, smokeCap } = args;
  let units = flattenSmokeUnits(planner);
  if (units.length === 0) units = smokeFallbackUnits(planner);
  if (units.length === 0) throw new Error("Smoke planner produced no capabilities or units");

  units.sort(compareSmokeUnitPriority);
  let droppedUnitIds: string[] = [];
  if (smokeCap > 0 && units.length > smokeCap) {
    droppedUnitIds = units.slice(smokeCap).map((u) => u.unit_id || "");
    units = units.slice(0, smokeCap);
  }

  const inventory: Dict = planner.mechanical_inventory ?? {};
  const unitsHash = smokeUnitsHash(units);

  const slots: Slot[] = [];
  for (let idx = 1; idx <= units.length; idx++) {
    const unit = units[idx - 1];
    const scenarioType = unit.scenario_type || "clean_baseline";
    // Exactly the two fields patternsForScenarioType reads (its param is the Pick).
    const capForPatterns = {
      recommended_conversation_patterns: unit.recommended_patterns,
      boundary_patterns: unit.boundary_patterns,
    };
    let patterns = patternsForScenarioType(capForPatterns, scenarioType, inventory);
    // Boundary-kind guardrail units default to the out-of-scope probe when available.
    if (scenarioType === "boundary_pressure" && unit.kind === "boundary" && patterns.includes("topic_out_of_scope")) {
      patterns = ["topic_out_of_scope", ...patterns.filter((p) => p !== "topic_out_of_scope")];
    }
    const patternId = patterns[0] ?? (SCENARIO_TYPE_DEFAULT_PATTERNS[scenarioType] ?? [""])[0];
    const pattern: Dict = CONVERSATION_PATTERNS[patternId] ?? {};
    // Reference divergence (inert): the Python smoke call passes inventory=None, which
    // only ever filters P10 — unreachable under smoke's clean/boundary scenario types
    // (language_switch is messy/recovery-only and boundary PERSONA_EXTRAS exclude P10).
    const personaIds = personaIdsForPattern(pattern, scenarioType, smokeCap, "smoke", inventory);
    const personaId = personaIds[0] ?? "P01";
    const entityId = pattern.entity_id || (scenarioType === "clean_baseline" ? "E01" : "E02");
    const route = smokeRouteFromUnit(unit);
    const routeIdValue = route.route_id || routeId(route);
    const outcomeSuffix = scenarioType === "boundary_pressure" ? "__boundary" : "";

    const slot: Slot = {
      slot_id: `S${String(idx).padStart(3, "0")}`,
      capability_id: unit.capability_id,
      capability_name: unit.capability_name || unit.capability_id,
      scenario_type: scenarioType,
      conversation_pattern_id: patternId,
      persona_combo_id: personaId,
      entity_format_combo_id: entityId,
      runtime_stress_combo_id: "R00",
      route_id: routeIdValue,
      mock_profile_id: "M_SUCCESS",
      expected_business_outcome: slug(unit.capability_name || unit.capability_id || "") + outcomeSuffix,
      expected_route_outcome: {
        source_node_id: route.source_node_id || "",
        expected_intent_name: route.intent_name || "",
        target_node_id: route.target_node_id || "",
        target_node_name: route.target_node_name || "",
        target_node_type: route.target_node_type || "",
      },
      required_mocked_actions: unit.action_anchors ?? [],
      variable_anchors: unit.variable_anchors ?? [],
      simulation_mode: "smoke",
      smoke_unit_id: unit.unit_id || "",
      smoke_unit_kind: unit.kind || "happy_path",
      smoke_unit_description: unit.description || "",
      smoke_units_hash: unitsHash,
      coverage_key: "",
    };
    slot.coverage_key = coverageKey(slot);
    slots.push(slot);
  }

  const audit = auditSmokeAllocation(slots, smokeCap);
  if (!audit.valid) throw new Error(`Smoke allocator audit failed: ${JSON.stringify(audit)}`);

  const capabilityQuotas: Record<string, number> = {};
  for (const slot of slots) capabilityQuotas[slot.capability_id] = (capabilityQuotas[slot.capability_id] ?? 0) + 1;

  return {
    requested_scenarios: slots.length,
    scenario_type_quotas: modeQuotasSmoke(units),
    capability_quotas: capabilityQuotas,
    allocation_matrix: [],
    slots,
    audit,
    smoke_units_hash: unitsHash,
    dropped_unit_ids: droppedUnitIds,
    simulation_mode: "smoke",
    smoke_cap: smokeCap,
  };
}
