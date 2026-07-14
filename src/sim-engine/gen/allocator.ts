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
import type { Capability } from "./schemas.js";
import type { Candidate, Slot, ExistingScenarioSummary, ExistingCoverage, PlannerWithInventory } from "./types.js";
import { slug } from "./text.js"; // pure leaf — keeps the allocator config-free (no planner/llm/config)

// AO Simulation Engine — DETERMINISTIC slot allocator (Phase 1.4).
//
// Byte-exact port of the orchestrator service's allocator (scenario_generator.py). NO randomness;
// every sort is total-order so output is reproducible given identical inputs. Pure:
// imports only the combo constants — no LLM, no config, no DB. Do not "tidy" the
// formulas/ordering: parity with the orchestrator service depends on them exactly.
//
// ONE deliberate divergence from the reference (2026-07-14): the reference filled
// requestedCount unconditionally, reusing coverage_keys when unique candidates ran
// out — every such slot was written by the LLM and then dropped by the downstream
// coverage_key dedup (pure token + latency waste; the writer also burns its retry
// ladder on slots the model declines to distinguish). This port instead relaxes
// quotas first, and when every distinct coverage_key is taken returns SHORT with
// audit.capacity_limited=true — planned_count < requested is an honest answer for
// flows whose coverage space is smaller than the ask.

type Dict = Record<string, any>;
const SEP = ""; // unit separator for pair/triple keys

// Shared with smoke-allocator.ts (which layers on this module's helpers).
export const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

export function patternsForScenarioType(
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

export function personaIdsForPattern(pattern: Dict, type: string, n: number, mode: string, inv: Dict): string[] {
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
export interface AllocateOptions {
  /** Coverage keys that must NOT be planned (exact-count top-up: every key already
   *  planned in the first wave). Seeded into the uniqueness filter. */
  excludeKeys?: ReadonlySet<string>;
  /** Offset for slot_id numbering so a top-up wave's ids continue after the first
   *  wave's (S001..Sxxx) instead of colliding with them. */
  slotIdOffset?: number;
  /** Waive the missing-core-capability audit rule — a top-up allocation is additive
   *  on a first wave that already guaranteed core coverage. */
  coreCoverageExempt?: boolean;
}

export function allocateScenarioSlots(
  planner: PlannerWithInventory,
  requestedCount: number,
  existingScenarios: ExistingScenarioSummary[] = [],
  opts: AllocateOptions = {},
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
  const selectedKeys = new Set<string>(opts.excludeKeys ?? []);
  const coveredPairs = new Set<string>();
  const coveredTriples = new Set<string>();
  let quotaRelaxed = false;
  // Candidate-pool expansion (exact-count): buildCandidates enumerates RELATIVE to
  // its n (per-axis combo breadth scales with it), so a pool that exhausts at n=40
  // is NOT the flow's real capacity — the same 1-capability flow that yields 29
  // unique keys at n=40 yields 100+ at n=100 (2026-07-14 probe). When unique
  // candidates run out, re-enumerate at a larger budget and keep filling. The
  // selection prefix stays byte-identical (expansion only fires where the old code
  // stopped). Cost: expansion triggers only on LOW-capability flows, where
  // enumeration is cheap (1-cap n=40 incl. one expansion: ~49ms measured); the
  // expensive enumerations (~1-2s at n=100 on many-cap flows) are the BASE build
  // that predates this ladder, and such flows never exhaust their pool.
  let candidatePool = candidates;
  let poolExpanded = false;
  let lastEnumN = requestedCount;
  const enumBudgets = [2, 5].map((m) => Math.min(500, Math.max(100, requestedCount * m)));
  let expansionStep = 0;

  while (selected.length < requestedCount) {
    let feasible = candidatePool.filter(
      (c) => (capRem[c.capability_id] ?? 0) > 0 && (typeRem[c.scenario_type] ?? 0) > 0 && !selectedKeys.has(c.coverage_key),
    );
    if (feasible.length === 0) {
      // Quota buckets ran out of unique candidates. DELIBERATE divergence from the
      // reference engine here (it dropped the uniqueness constraint instead): a slot
      // whose coverage_key is already selected can only ever be written and then
      // dropped by generate.ts's dedup — guaranteed writer-token waste (2026-07-14
      // prod: 12 of 40 planned slots on a 1-capability flow were exactly this).
      // Uniqueness is the hard constraint; quotas are preferences, so relax quotas.
      feasible = candidatePool.filter((c) => !selectedKeys.has(c.coverage_key));
      if (feasible.length > 0) quotaRelaxed = true;
    }
    while (feasible.length === 0 && expansionStep < enumBudgets.length) {
      // Unique candidates exhausted at the current enumeration budget — expand the
      // pool and keep filling toward the exact requested count.
      const budget = enumBudgets[expansionStep++];
      if (budget <= lastEnumN) continue;
      lastEnumN = budget;
      candidatePool = buildCandidates(
        capabilities,
        allocateCapabilityQuotas(capabilities, budget, existing),
        scenarioTypeQuotas(budget),
        existing,
        inv,
        budget,
      );
      poolExpanded = true;
      feasible = candidatePool.filter((c) => !selectedKeys.has(c.coverage_key));
      if (feasible.length > 0) quotaRelaxed = true;
    }
    if (feasible.length === 0) {
      // Even the expanded enumeration is out of distinct coverage_keys: this PLAN's
      // capacity is reached. Return short HONESTLY (planned_count < requested) and
      // let the caller decide: generate.ts treats capacity_limited as a replan
      // trigger while planner-retry attempts remain (a thin plan — not the flow —
      // may be the real limit) and accepts the short result only on the final
      // attempt, never caching a capacity-limited plan.
      break;
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
      slot_id: `S${String((opts.slotIdOffset ?? 0) + selected.length + 1).padStart(3, "0")}`,
      simulation_mode: "stress",
    };
    selected.push(chosen);
    selectedKeys.add(chosen.coverage_key);
    // Quota-relaxed (and expanded-pool) picks can come from a capability/type with
    // no quota entry — `undefined - 1` is NaN, which would poison scoreCandidate
    // (NaN survives its `?? 0`) and break the deterministic tiebreak chain for
    // every later sibling of that capability. Coerce absent to 0; negatives are
    // fine (stage-2 selection ignores quotas by design).
    capRem[chosen.capability_id] = (capRem[chosen.capability_id] ?? 0) - 1;
    typeRem[chosen.scenario_type] = (typeRem[chosen.scenario_type] ?? 0) - 1;
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

  const capacityLimited = selected.length < requestedCount;
  const audit = auditAllocation(selected, requestedCount, typeQuotas, capabilities, {
    capacityLimited,
    quotaRelaxed,
    poolExpanded,
    coreCoverageExempt: opts.coreCoverageExempt,
  });
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
  /** Allocation stopped short of requested: every distinct coverage_key was taken
   *  (the flow's coverage capacity). planned_count < requested is expected then. */
  capacity_limited: boolean;
  /** Type/capability quotas were relaxed to keep coverage_keys unique (uniqueness
   *  is the hard constraint; the exact quota split is a preference). */
  quota_relaxed: boolean;
  /** The candidate pool was re-enumerated at a larger budget to reach the requested
   *  count (exact-count expansion). Observability only — not a validity input. */
  pool_expanded: boolean;
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
  flags: { capacityLimited?: boolean; quotaRelaxed?: boolean; poolExpanded?: boolean; coreCoverageExempt?: boolean } = {},
): AuditResult {
  const capacityLimited = flags.capacityLimited ?? false;
  const quotaRelaxed = flags.quotaRelaxed ?? false;
  const poolExpanded = flags.poolExpanded ?? false;
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
  // A top-up allocation is additive on a first wave that already covered core caps.
  const missingCore =
    !flags.coreCoverageExempt && requestedCount >= coreCaps.length ? coreCaps.filter((id) => !coveredCaps.has(id)) : [];

  const quotasMatch = (Object.keys(typeQuotas) as Array<keyof ScenarioTypeQuotas>).every(
    (t) => (scenarioTypeCounts[t] ?? 0) === typeQuotas[t],
  );

  // capacity_limited waives the exact-count requirement (the flow cannot support
  // more distinct scenarios); quota_relaxed (or a short allocation) waives the
  // exact quota split. Uniqueness (duplicate_coverage_keys empty) is enforced
  // ALWAYS now — the selection loop never reuses a key anymore.
  const valid =
    (slots.length === requestedCount || capacityLimited) &&
    invalidComboIds.length === 0 &&
    invalidRuntimePairs.length === 0 &&
    invalidScenarioTypeMockPairs.length === 0 &&
    duplicateKeys.length === 0 &&
    missingCore.length === 0 &&
    (quotasMatch || quotaRelaxed || capacityLimited);

  return {
    valid,
    requested_scenarios: requestedCount,
    actual_slots: slots.length,
    capacity_limited: capacityLimited,
    quota_relaxed: quotaRelaxed,
    pool_expanded: poolExpanded,
    scenario_type_counts: scenarioTypeCounts,
    expected_scenario_type_counts: typeQuotas,
    invalid_combo_ids: invalidComboIds,
    invalid_pattern_runtime_pairs: invalidRuntimePairs,
    invalid_scenario_type_mock_pairs: invalidScenarioTypeMockPairs,
    duplicate_coverage_keys: duplicateKeys,
    missing_core_capabilities: missingCore,
  };
}

