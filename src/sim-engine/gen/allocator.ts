import {
  PERSONA_COMBOS,
  ENTITY_FORMAT_COMBOS,
  RUNTIME_STRESS_COMBOS,
  MOCK_PROFILES,
  CONVERSATION_PATTERNS,
  SCENARIO_TYPE_DEFAULT_PATTERNS,
  SCENARIO_TYPE_ORDER,
  PRIORITY_WEIGHT,
  RISK_WEIGHT,
  PATTERN_PRIORITY,
  OUTBOUND_PATTERN_BOOST,
  ALLOCATION_AXES,
  HIGH_RISK_TRIPLES,
  type AllocationAxis,
} from "./combos.js";
import { createHash } from "node:crypto"; // deterministic builtin (smoke units hash) — the config-free contract holds
import type { Capability, SmokeUnit } from "./schemas.js";
import type { Candidate, Slot, ExistingScenarioSummary, ExistingCoverage, PlannerWithInventory } from "./types.js";
import { slug } from "./text.js"; // pure leaf — keeps the allocator config-free (no planner/llm/config)

// AO Simulation Engine — DETERMINISTIC slot allocator (Phase 1.4).
//
// Byte-exact port of the orchestrator service's allocator (scenario_generator.py). NO randomness;
// every sort is total-order so output is reproducible given identical inputs. Pure:
// imports only the combo constants — no LLM, no config, no DB. Do not "tidy" the
// formulas/ordering: parity with the orchestrator service depends on them exactly.

type Dict = Record<string, any>;
const SEP = ""; // unit separator for pair/triple keys

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── quotas ─────────────────────────────────────────────────────────────────────

export type ScenarioTypeQuotas = {
  clean_baseline: number;
  messy_success: number;
  recovery_success: number;
  boundary_pressure: number;
};

/** Per-scenario-type counts for `n` scenarios. Key insertion order
 *  (clean→messy→recovery→boundary) is load-bearing for candidate enumeration. */
export function scenarioTypeQuotas(n: number): ScenarioTypeQuotas {
  if (n === 1) return { clean_baseline: 0, messy_success: 1, recovery_success: 0, boundary_pressure: 0 };
  if (n === 2) return { clean_baseline: 1, messy_success: 1, recovery_success: 0, boundary_pressure: 0 };
  if (n === 3) return { clean_baseline: 1, messy_success: 1, recovery_success: 1, boundary_pressure: 0 };

  let clean = Math.max(1, Math.min(2, Math.floor(n / 50)));
  let boundary = Math.max(1, Math.round(n * 0.12));
  let recovery = Math.max(1, Math.round(n * 0.24));

  // Trim overflow in the fixed order boundary → recovery → clean.
  if (clean + boundary + recovery > n - 1) {
    let overflow = clean + boundary + recovery - (n - 1);
    const buckets: Array<["boundary" | "recovery" | "clean", () => number, (v: number) => void]> = [
      ["boundary", () => boundary, (v) => (boundary = v)],
      ["recovery", () => recovery, (v) => (recovery = v)],
      ["clean", () => clean, (v) => (clean = v)],
    ];
    for (const [, get, set] of buckets) {
      if (overflow <= 0) break;
      const reduceBy = Math.min(Math.max(0, get() - 1), overflow);
      if (reduceBy <= 0) continue;
      set(get() - reduceBy);
      overflow -= reduceBy;
    }
  }
  const messy = n - clean - boundary - recovery;
  return { clean_baseline: clean, messy_success: messy, recovery_success: recovery, boundary_pressure: boundary };
}

/** Slots per capability — weighted by priority/risk/anchors, saturation-penalized,
 *  core-guaranteed, remainder distributed proportionally. */
export function allocateCapabilityQuotas(
  capabilities: Capability[],
  n: number,
  existing: ExistingCoverage,
): Record<string, number> {
  const weighted = capabilities.map((cap) => {
    const capId = cap.capability_id || slug(cap.name || "capability");
    const base =
      (PRIORITY_WEIGHT[cap.priority] ?? 1.0) +
      (RISK_WEIGHT[cap.risk] ?? 0.0) +
      Math.min((cap.action_anchors ?? []).length, 3) * 0.25 +
      Math.min((cap.variable_anchors ?? []).length, 5) * 0.1;
    const coverageCredit = existing.capability[capId] ?? 0;
    const penalty = Math.max(0.5, 1 - Math.min(coverageCredit, 10) * 0.05);
    return { capId, cap, weight: Math.max(base * penalty, 0.1) };
  });
  weighted.sort((a, b) => (a.weight !== b.weight ? b.weight - a.weight : cmpStr(a.capId, b.capId)));

  // Core capabilities are guaranteed a seat before the weight cut — but ONLY in the regime
  // the audit enforces: auditAllocation requires EVERY core cap covered when n >= coreCount,
  // so there a high-weight boundary cap outweighing a low-weight core cap would make the
  // audit throw deterministically (and the replan retry fail the same way). When n < coreCount
  // the audit waives core coverage entirely, and the original pure weight slice is the correct
  // (and previously shipped) behavior — do not reshape small allocations. Both lists keep the
  // weight order, so determinism is preserved either way.
  let selected: typeof weighted;
  if (n < weighted.length) {
    const core = weighted.filter((w) => w.cap.priority === "core");
    if (n >= core.length) {
      const rest = weighted.filter((w) => w.cap.priority !== "core");
      selected = [...core, ...rest.slice(0, n - core.length)];
    } else {
      selected = weighted.slice(0, n);
    }
  } else {
    selected = weighted;
  }
  const quotas: Record<string, number> = {};
  for (const { capId } of selected) quotas[capId] = 0;

  const coreIds = selected.filter((w) => w.cap.priority === "core").map((w) => w.capId);
  if (n >= coreIds.length) {
    for (const id of coreIds) quotas[id] = 1;
  } else {
    for (const id of coreIds.slice(0, n)) quotas[id] = 1;
  }

  let remaining = n - Object.values(quotas).reduce((a, b) => a + b, 0);
  const totalWeight = selected.filter((w) => w.capId in quotas).reduce((a, w) => a + w.weight, 0);
  const fractional: Array<{ frac: number; capId: string }> = [];
  for (const { capId, weight } of selected) {
    if (!(capId in quotas)) continue;
    const raw = totalWeight ? remaining * (weight / totalWeight) : 0;
    const whole = Math.floor(raw);
    quotas[capId] += whole;
    fractional.push({ frac: raw - whole, capId });
  }
  const left = n - Object.values(quotas).reduce((a, b) => a + b, 0);
  fractional.sort((a, b) => (a.frac !== b.frac ? b.frac - a.frac : cmpStr(a.capId, b.capId)));
  for (const { capId } of fractional.slice(0, left)) quotas[capId] += 1;
  return quotas;
}

// ── existing coverage ────────────────────────────────────────────────────────────

export function existingCoverage(summaries: ExistingScenarioSummary[]): ExistingCoverage {
  const full: Record<string, number> = {};
  const capability: Record<string, number> = {};
  const capability_scenario_type: Record<string, number> = {};
  for (const s of summaries) {
    const credit = s.classification_confidence === "high" ? 1.0 : 0.25;
    if (s.coverage_key) full[s.coverage_key] = (full[s.coverage_key] ?? 0) + credit;
    if (s.capability_id && s.capability_id !== "legacy_unclassified") {
      capability[s.capability_id] = (capability[s.capability_id] ?? 0) + credit;
      if (s.scenario_type && s.scenario_type !== "legacy_unclassified") {
        const k = `${s.capability_id}|${s.scenario_type}`;
        capability_scenario_type[k] = (capability_scenario_type[k] ?? 0) + credit;
      }
    }
  }
  return { full, capability, capability_scenario_type };
}

// ── per-axis enumeration ─────────────────────────────────────────────────────────

function dedup(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) if (!seen.has(id)) (seen.add(id), out.push(id));
  return out;
}

function patternsForScenarioType(
  // Structural subset — exactly the two fields this function reads, so the smoke
  // allocator's per-unit view passes without casts and a future field-read here
  // becomes a compile error at both call sites instead of a silent undefined.
  cap: Pick<Capability, "recommended_conversation_patterns" | "boundary_patterns">,
  type: string,
  inv: Dict,
): string[] {
  let recommended = [...(cap.recommended_conversation_patterns ?? [])];
  if (type === "boundary_pressure") recommended = recommended.concat(cap.boundary_patterns ?? []);
  const languages = inv.languages ?? [];
  const out: string[] = [];
  for (const pid of recommended.concat(SCENARIO_TYPE_DEFAULT_PATTERNS[type] ?? [])) {
    const pattern = CONVERSATION_PATTERNS[pid];
    if (!pattern || !pattern.scenario_types.includes(type)) continue;
    if (pid === "language_switch" && languages.length < 2) continue;
    if (pid === "gatekeeper_or_hold" && !inv.is_outbound_call) continue;
    if (!out.includes(pid)) out.push(pid);
  }
  return out.length ? out : (SCENARIO_TYPE_DEFAULT_PATTERNS[type] ?? []).slice(0, 1);
}

const PERSONA_EXTRAS: Record<string, string[]> = {
  messy_success: ["P02", "P03", "P04", "P05", "P07", "P10", "P11", "P13", "P15"],
  recovery_success: ["P03", "P04", "P05", "P06", "P08", "P12", "P16"],
  boundary_pressure: ["P03", "P04", "P09", "P11", "P17", "P18", "P19"],
};
const ENTITY_EXTRAS: Record<string, string[]> = {
  messy_success: ["E01", "E02", "E04", "E05"],
  recovery_success: ["E02", "E03", "E06", "E07", "E08"],
  boundary_pressure: ["E01", "E02", "E05"],
};
const STRESS_EXTRAS: Record<string, string[]> = {
  messy_success: ["R00", "R01", "R02", "R03", "R04"],
  recovery_success: ["R00", "R01", "R03", "R04"],
  boundary_pressure: ["R00", "R01", "R02"],
};

function personaIdsForPattern(pattern: Dict, type: string, n: number, mode: string, inv: Dict): string[] {
  let ids = [...(pattern.persona_ids ?? ["P02"])];
  if (type === "clean_baseline" && !ids.includes("P14")) {
    ids = ["P01"];
  } else if (mode === "smoke" || n >= 50) {
    ids = ids.concat(PERSONA_EXTRAS[type] ?? []);
  }
  const languages = inv.languages ?? [];
  if (languages.length < 2) ids = ids.filter((p) => p !== "P10");
  return dedup(ids).filter((p) => p in PERSONA_COMBOS);
}

function entityIdsForPattern(pattern: Dict, type: string, n: number): string[] {
  let ids = [pattern.entity_id || "E01"];
  if (type === "clean_baseline") ids = ["E01"];
  else if (n >= 50) ids = ids.concat(ENTITY_EXTRAS[type] ?? []);
  return dedup(ids).filter((e) => e in ENTITY_FORMAT_COMBOS);
}

function stressIdsForPattern(pattern: Dict, type: string, n: number): string[] {
  let ids = [pattern.stress_id || "R00"];
  if (type === "clean_baseline") ids = ["R00"];
  else if (n >= 50) ids = ids.concat(STRESS_EXTRAS[type] ?? []);
  return dedup(ids).filter((r) => r in RUNTIME_STRESS_COMBOS);
}

function allowedMockProfiles(type: string, hasActions: boolean, n: number): string[] {
  if (type === "clean_baseline") return ["M_SUCCESS"];
  if (type === "recovery_success" && hasActions && n >= 50) return ["M_SUCCESS", "M_RECOVERABLE_FAILURE"];
  return ["M_SUCCESS"];
}

// ── coverage key + pair/triple coverage ──────────────────────────────────────────

export function coverageKey(c: Dict): string {
  return ALLOCATION_AXES.map((a) => String(c[a] ?? "unknown")).join("|");
}

function pairValues(c: Dict): Set<string> {
  const vals = ALLOCATION_AXES.map((a) => [a, String(c[a] ?? "")] as const);
  const out = new Set<string>();
  for (let i = 0; i < vals.length; i++)
    for (let j = i + 1; j < vals.length; j++)
      out.add(`${vals[i][0]}${SEP}${vals[i][1]}${SEP}${vals[j][0]}${SEP}${vals[j][1]}`);
  return out;
}

function tripleValues(c: Dict): Set<string> {
  const out = new Set<string>();
  for (const axes of HIGH_RISK_TRIPLES) {
    out.add(axes.map((a: AllocationAxis) => `${a}${SEP}${String(c[a] ?? "")}`).join(SEP));
  }
  return out;
}

function countNew(values: Set<string>, covered: Set<string>): number {
  let n = 0;
  for (const v of values) if (!covered.has(v)) n++;
  return n;
}

function scoreCandidate(
  c: Dict,
  capRem: Record<string, number>,
  typeRem: Record<string, number>,
  coveredPairs: Set<string>,
  coveredTriples: Set<string>,
  existing: ExistingCoverage,
  isOutbound: boolean,
): number {
  const pairGain = countNew(pairValues(c), coveredPairs);
  const tripleGain = countNew(tripleValues(c), coveredTriples);
  const dupPenalty = (existing.full[c.coverage_key] ?? 0) > 0 ? 100 : 0;
  const saturation = Math.min(existing.capability[c.capability_id] ?? 0, 10) * 2;
  const outboundBoost = isOutbound ? OUTBOUND_PATTERN_BOOST[c.conversation_pattern_id] ?? 0 : 0;
  return (
    (capRem[c.capability_id] ?? 0) * 80 +
    (typeRem[c.scenario_type] ?? 0) * 60 +
    pairGain * 4 +
    tripleGain * 12 +
    (PATTERN_PRIORITY[c.conversation_pattern_id] ?? 0) +
    outboundBoost -
    dupPenalty -
    saturation
  );
}

// ── candidates ───────────────────────────────────────────────────────────────────

export function routeId(route: Dict): string {
  return route.route_id || `${route.source_node_id || ""}:${route.intent_name || ""}`;
}

function buildCandidates(
  capabilities: Capability[],
  capabilityQuotas: Record<string, number>,
  typeQuotas: ScenarioTypeQuotas,
  existing: ExistingCoverage,
  inv: Dict,
  n: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const cap of capabilities) {
    // MUST match allocateCapabilityQuotas' key derivation exactly: the planner runs
    // strict:false, so a capability can arrive with capability_id="" — quotas key it under
    // slug(name), and skipping it here would leave that quota bucket with zero candidates
    // (→ "could not satisfy exact count" for the whole run).
    const capId = cap.capability_id || slug(cap.name || "capability");
    if (!capId || (capabilityQuotas[capId] ?? 0) <= 0) continue;
    const routes: Dict[] =
      cap.route_anchors && cap.route_anchors.length
        ? cap.route_anchors
        : [{ route_id: "", source_node_id: "", intent_name: "", target_node_type: "" }];
    const hasActions = !!(cap.action_anchors && cap.action_anchors.length);

    for (const scenarioType of Object.keys(typeQuotas) as Array<keyof ScenarioTypeQuotas>) {
      if (typeQuotas[scenarioType] <= 0) continue;
      for (const patternId of patternsForScenarioType(cap, scenarioType, inv)) {
        const pattern = CONVERSATION_PATTERNS[patternId];
        if (!pattern || !pattern.scenario_types.includes(scenarioType)) continue;
        for (const personaId of personaIdsForPattern(pattern, scenarioType, n, "stress", inv)) {
          for (const entityId of entityIdsForPattern(pattern, scenarioType, n)) {
            for (const stressId of stressIdsForPattern(pattern, scenarioType, n)) {
              for (const route of routes) {
                if (route.support === "blocked") continue;
                for (const mockProfileId of allowedMockProfiles(scenarioType, hasActions, n)) {
                  const candidate: Candidate = {
                    capability_id: capId,
                    capability_name: cap.name,
                    scenario_type: scenarioType,
                    conversation_pattern_id: patternId,
                    persona_combo_id: personaId,
                    entity_format_combo_id: entityId,
                    runtime_stress_combo_id: stressId,
                    route_id: routeId(route),
                    mock_profile_id: mockProfileId,
                    expected_business_outcome: slug(cap.name || ""),
                    expected_route_outcome: {
                      source_node_id: route.source_node_id || "",
                      expected_intent_name: route.intent_name || "",
                      target_node_id: route.target_node_id || "",
                      target_node_name: route.target_node_name || "",
                      target_node_type: route.target_node_type || "",
                    },
                    required_mocked_actions: cap.action_anchors ?? [],
                    variable_anchors: cap.variable_anchors ?? [],
                    coverage_key: "",
                  };
                  candidate.coverage_key = coverageKey(candidate);
                  candidates.push(candidate);
                }
              }
            }
          }
        }
      }
    }
  }

  if (candidates.length <= 10_000) return candidates;
  // Prune: group by (capability_id, scenario_type), keep top 200 by priority/coverage.
  const grouped = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = `${c.capability_id}${SEP}${c.scenario_type}`;
    (grouped.get(k) ?? grouped.set(k, []).get(k)!).push(c);
  }
  const pruned: Candidate[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => {
      const pa = PATTERN_PRIORITY[a.conversation_pattern_id] ?? 0;
      const pb = PATTERN_PRIORITY[b.conversation_pattern_id] ?? 0;
      if (pa !== pb) return pb - pa;
      const ea = existing.full[a.coverage_key] ?? 0;
      const eb = existing.full[b.coverage_key] ?? 0;
      if (ea !== eb) return ea - eb;
      return cmpStr(a.coverage_key, b.coverage_key);
    });
    pruned.push(...group.slice(0, 200));
  }
  return pruned;
}


const GENERIC_CAPABILITY: Capability = {
  capability_id: "general_conversation",
  name: "General conversation",
  description: "Exercise the primary agent conversation.",
  priority: "core",
  risk: "medium",
  source_signals: ["fallback"],
  success_criteria: ["Agent handles the caller request"],
  route_anchors: [],
  action_anchors: [],
  variable_anchors: [],
  recommended_conversation_patterns: [],
  boundary_patterns: [],
  smoke_units: [],
};

export interface AllocationResult {
  requested_scenarios: number;
  scenario_type_quotas: ScenarioTypeQuotas;
  capability_quotas: Record<string, number>;
  allocation_matrix: Array<Dict & { count: number }>;
  slots: Slot[];
  audit: AuditResult;
}

/** The deterministic greedy allocation. Reproducible given identical inputs. */
export function allocateScenarioSlots(
  planner: PlannerWithInventory,
  requestedCount: number,
  existingScenarios: ExistingScenarioSummary[] = [],
): AllocationResult {
  const existing = existingCoverage(existingScenarios);
  const inv: Dict = planner.mechanical_inventory ?? {};
  let capabilities = planner.capabilities ?? [];
  if (capabilities.length === 0) capabilities = [GENERIC_CAPABILITY];

  const capabilityQuotas = allocateCapabilityQuotas(capabilities, requestedCount, existing);
  const typeQuotas = scenarioTypeQuotas(requestedCount);
  const candidates = buildCandidates(capabilities, capabilityQuotas, typeQuotas, existing, inv, requestedCount);
  if (candidates.length === 0) throw new Error("Allocator produced no candidates");

  const isOutbound = !!inv.is_outbound_call;
  const capPriority: Record<string, string> = {};
  // Same key derivation as quotas/candidates (slug fallback for empty capability_id).
  for (const cap of capabilities) capPriority[cap.capability_id || slug(cap.name || "capability")] = cap.priority;

  const capRem: Record<string, number> = { ...capabilityQuotas };
  const typeRem: Record<string, number> = { ...typeQuotas };
  const selected: Slot[] = [];
  const selectedKeys = new Set<string>();
  const coveredPairs = new Set<string>();
  const coveredTriples = new Set<string>();

  while (selected.length < requestedCount) {
    let feasible = candidates.filter(
      (c) => (capRem[c.capability_id] ?? 0) > 0 && (typeRem[c.scenario_type] ?? 0) > 0 && !selectedKeys.has(c.coverage_key),
    );
    if (feasible.length === 0) {
      feasible = candidates.filter((c) => (capRem[c.capability_id] ?? 0) > 0 && (typeRem[c.scenario_type] ?? 0) > 0);
    }
    if (feasible.length === 0) {
      throw new Error(`Allocator could not satisfy exact count: selected=${selected.length}, requested=${requestedCount}`);
    }

    const scored = feasible.map((c) => ({
      c,
      score: scoreCandidate(c, capRem, typeRem, coveredPairs, coveredTriples, existing, isOutbound),
      pw: PRIORITY_WEIGHT[capPriority[c.capability_id]] ?? 1.0,
    }));
    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score; // 1: -score
      if (a.pw !== b.pw) return b.pw - a.pw; // 2: -priority_weight
      if (a.c.capability_id !== b.c.capability_id) return cmpStr(a.c.capability_id, b.c.capability_id); // 3
      const sa = SCENARIO_TYPE_ORDER[a.c.scenario_type] ?? 99;
      const sb = SCENARIO_TYPE_ORDER[b.c.scenario_type] ?? 99;
      if (sa !== sb) return sa - sb; // 4
      const pa = PATTERN_PRIORITY[a.c.conversation_pattern_id] ?? 0;
      const pb = PATTERN_PRIORITY[b.c.conversation_pattern_id] ?? 0;
      if (pa !== pb) return pb - pa; // 5: -pattern_priority
      if (a.c.conversation_pattern_id !== b.c.conversation_pattern_id) return cmpStr(a.c.conversation_pattern_id, b.c.conversation_pattern_id); // 6
      if (a.c.persona_combo_id !== b.c.persona_combo_id) return cmpStr(a.c.persona_combo_id, b.c.persona_combo_id); // 7
      if (a.c.entity_format_combo_id !== b.c.entity_format_combo_id) return cmpStr(a.c.entity_format_combo_id, b.c.entity_format_combo_id); // 8
      if (a.c.runtime_stress_combo_id !== b.c.runtime_stress_combo_id) return cmpStr(a.c.runtime_stress_combo_id, b.c.runtime_stress_combo_id); // 9
      if (a.c.route_id !== b.c.route_id) return cmpStr(a.c.route_id, b.c.route_id); // 10
      return cmpStr(a.c.mock_profile_id, b.c.mock_profile_id); // 11
    });

    const chosen: Slot = {
      ...scored[0].c,
      slot_id: `S${String(selected.length + 1).padStart(3, "0")}`,
      simulation_mode: "stress",
    };
    selected.push(chosen);
    selectedKeys.add(chosen.coverage_key);
    capRem[chosen.capability_id] -= 1;
    typeRem[chosen.scenario_type] -= 1;
    for (const p of pairValues(chosen)) coveredPairs.add(p);
    for (const t of tripleValues(chosen)) coveredTriples.add(t);
  }

  // allocation_matrix: count of each unique 8-axis combo, sorted by the axis tuple.
  const counts = new Map<string, number>();
  for (const s of selected) {
    const key = ALLOCATION_AXES.map((a) => String((s as Dict)[a] ?? "")).join(SEP);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const matrix = [...counts.entries()]
    .sort((a, b) => cmpStr(a[0], b[0]))
    .map(([key, count]) => {
      const parts = key.split(SEP);
      const row: Dict & { count: number } = { count };
      ALLOCATION_AXES.forEach((a, i) => (row[a] = parts[i]));
      return row;
    });

  const audit = auditAllocation(selected, requestedCount, typeQuotas, capabilities);
  if (!audit.valid) throw new Error(`Allocator audit failed: ${JSON.stringify(audit)}`);

  return {
    requested_scenarios: requestedCount,
    scenario_type_quotas: typeQuotas,
    capability_quotas: capabilityQuotas,
    allocation_matrix: matrix,
    slots: selected,
    audit,
  };
}

// ── audit ─────────────────────────────────────────────────────────────────────────

export interface AuditResult {
  valid: boolean;
  requested_scenarios: number;
  actual_slots: number;
  scenario_type_counts: Record<string, number>;
  expected_scenario_type_counts: ScenarioTypeQuotas;
  invalid_combo_ids: Array<{ slot_id: string; field: string; value: unknown }>;
  invalid_pattern_runtime_pairs: Array<{ slot_id: string; pattern: string }>;
  invalid_scenario_type_mock_pairs: string[];
  duplicate_coverage_keys: string[];
  missing_core_capabilities: string[];
}

export function auditAllocation(
  slots: Slot[],
  requestedCount: number,
  typeQuotas: ScenarioTypeQuotas,
  capabilities: Capability[],
): AuditResult {
  const invalidComboIds: AuditResult["invalid_combo_ids"] = [];
  const invalidRuntimePairs: AuditResult["invalid_pattern_runtime_pairs"] = [];
  const invalidScenarioTypeMockPairs: string[] = [];
  const duplicateKeys: string[] = [];
  const seen = new Set<string>();

  const libs: Array<[keyof Slot, Record<string, unknown>]> = [
    ["persona_combo_id", PERSONA_COMBOS],
    ["entity_format_combo_id", ENTITY_FORMAT_COMBOS],
    ["runtime_stress_combo_id", RUNTIME_STRESS_COMBOS],
    ["mock_profile_id", MOCK_PROFILES],
  ];
  for (const slot of slots) {
    for (const [field, lib] of libs) {
      if (!((slot[field] as string) in lib)) invalidComboIds.push({ slot_id: slot.slot_id, field, value: slot[field] });
    }
    const pattern = CONVERSATION_PATTERNS[slot.conversation_pattern_id];
    if (!pattern || !pattern.scenario_types.includes(slot.scenario_type)) {
      invalidRuntimePairs.push({ slot_id: slot.slot_id, pattern: slot.conversation_pattern_id });
    }
    if (slot.scenario_type === "clean_baseline" && slot.mock_profile_id !== "M_SUCCESS") {
      invalidScenarioTypeMockPairs.push(slot.slot_id);
    }
    if (seen.has(slot.coverage_key)) duplicateKeys.push(slot.coverage_key);
    seen.add(slot.coverage_key);
  }

  const scenarioTypeCounts: Record<string, number> = {};
  for (const s of slots) scenarioTypeCounts[s.scenario_type] = (scenarioTypeCounts[s.scenario_type] ?? 0) + 1;

  const coveredCaps = new Set(slots.map((s) => s.capability_id));
  // Slug fallback matches the quota/candidate key derivation — slots carry the derived key,
  // so the audit must compare against the same one.
  const coreCaps = capabilities.filter((c) => c.priority === "core").map((c) => c.capability_id || slug(c.name || "capability"));
  const missingCore = requestedCount >= coreCaps.length ? coreCaps.filter((id) => !coveredCaps.has(id)) : [];

  const quotasMatch = (Object.keys(typeQuotas) as Array<keyof ScenarioTypeQuotas>).every(
    (t) => (scenarioTypeCounts[t] ?? 0) === typeQuotas[t],
  );

  const valid =
    slots.length === requestedCount &&
    invalidComboIds.length === 0 &&
    invalidRuntimePairs.length === 0 &&
    invalidScenarioTypeMockPairs.length === 0 &&
    missingCore.length === 0 &&
    quotasMatch;

  return {
    valid,
    requested_scenarios: requestedCount,
    actual_slots: slots.length,
    scenario_type_counts: scenarioTypeCounts,
    expected_scenario_type_counts: typeQuotas,
    invalid_combo_ids: invalidComboIds,
    invalid_pattern_runtime_pairs: invalidRuntimePairs,
    invalid_scenario_type_mock_pairs: invalidScenarioTypeMockPairs,
    duplicate_coverage_keys: duplicateKeys,
    missing_core_capabilities: missingCore,
  };
}

// ── SMOKE mode ─────────────────────────────────────────────────────────────────
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
// sort, sha256 hash). node:crypto is a deterministic builtin — the "pure" contract
// in the header (no LLM/config/DB) still holds.

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

/** Pull smoke_units out of each capability and attach capability context.
 *  Units without a `unit_id` are skipped (planner contract violation); uniqueness
 *  of unit_id is the planner's job and re-checked by the smoke audit. */
export function flattenSmokeUnits(planner: PlannerWithInventory): EnrichedSmokeUnit[] {
  const units: EnrichedSmokeUnit[] = [];
  for (const cap of (planner.capabilities ?? []) as Capability[]) {
    if (!cap || typeof cap !== "object") continue;
    // Same key derivation as the stress quotas/candidates/audit (slug fallback for
    // an empty capability_id) so smoke slots share the capability namespace.
    const capId = cap.capability_id || slug(cap.name || "capability");
    for (const unit of cap.smoke_units ?? []) {
      if (!unit || typeof unit !== "object" || !unit.unit_id) continue;
      units.push({
        ...unit,
        capability_id: capId,
        capability_name: cap.name || capId,
        capability_priority: cap.priority || "secondary",
        capability_risk: cap.risk || "medium",
        action_anchors: cap.action_anchors ?? [],
        variable_anchors: cap.variable_anchors ?? [],
        recommended_patterns: cap.recommended_conversation_patterns ?? [],
        boundary_patterns: cap.boundary_patterns ?? [],
        route_anchors: (cap.route_anchors ?? []) as Dict[],
      });
    }
  }
  return units;
}

/** If the planner forgot smoke_units entirely, synthesize one clean happy-path
 *  unit per non-blocked capability (`{capId}__happy_path__001`). */
export function smokeFallbackUnits(planner: PlannerWithInventory): EnrichedSmokeUnit[] {
  const fallback: EnrichedSmokeUnit[] = [];
  for (const cap of (planner.capabilities ?? []) as Capability[]) {
    if (!cap || typeof cap !== "object") continue;
    const capId = cap.capability_id || slug(cap.name || "capability");
    if (!capId) continue;
    const routeAnchors = (cap.route_anchors ?? []) as Dict[];
    const firstRoute = routeAnchors.length && typeof routeAnchors[0] === "object" ? routeAnchors[0] : {};
    if (firstRoute.support === "blocked") continue;
    fallback.push({
      unit_id: `${capId}__happy_path__001`,
      kind: "happy_path",
      scenario_type: "clean_baseline",
      route_id: firstRoute.route_id || routeId(firstRoute),
      description: `Fallback smoke unit for ${capId}`,
      capability_id: capId,
      capability_name: cap.name || capId,
      capability_priority: cap.priority || "core",
      capability_risk: cap.risk || "medium",
      action_anchors: cap.action_anchors ?? [],
      variable_anchors: cap.variable_anchors ?? [],
      recommended_patterns: cap.recommended_conversation_patterns ?? [],
      boundary_patterns: cap.boundary_patterns ?? [],
      route_anchors: routeAnchors,
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
 *  when pinned. `existingScenarios` is accepted for signature parity but unused —
 *  smoke has no cross-batch dedup (the unit list IS the coverage contract). */
export function allocateSmokeSlots(args: {
  planner: PlannerWithInventory;
  smokeCap: number;
  existingScenarios?: ExistingScenarioSummary[];
}): SmokeAllocationResult {
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
