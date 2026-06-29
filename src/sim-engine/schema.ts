import { z } from "zod";
import { normalizeFlow } from "../simulation/flow/flow-normalize.js";
import type { CanonicalFlow } from "../simulation/flow/flow-schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// AO Simulation Engine — boundary schemas (Phase 0.3)
//
// Three contracts live here:
//   1. The HTTP request bodies for generate/run — mirrored EXACTLY from the orchestrator service
//      (plan.md: `models/simulation.py` GenerateScenariosRequest /
//      RunScenariosRequest), so the future console cutover is near-zero change.
//   2. `flow_json` validation — we DON'T re-describe the messy console shape with
//      a bespoke Zod (it has two real-world variants). Instead we delegate to the
//      ported `normalizeFlow`, which folds ANY accepted shape into the single
//      `CanonicalFlow` and is exactly what the worker's ParseFlowGraph expects
//      (see the design notes). `parseFlowJson()` is that boundary gate.
//   3. The Scenario dict — matched field-for-field to the worker's
//      `SimulationScenario` Go struct (the reference worker
//      usecases/simulation_eval/models.go L44-64), since AO produces scenarios
//      (the WRITER) and later enqueues them for that worker to unmarshal.
// ─────────────────────────────────────────────────────────────────────────────

/** Simulation difficulty mode. "stress" is the default; "smoke" is the capped, fast path. */
export const SimulationMode = z.enum(["smoke", "stress"]);
export type SimulationMode = z.infer<typeof SimulationMode>;

// `flow_json` arrives as an arbitrary JSON object at the request boundary; its
// real structural validation is `parseFlowJson()` below (normalizeFlow). Keeping
// it loose here means we accept BOTH the console "canonical" shape and the
// flow editor "stored" shape without rejecting one at the Zod layer.
const FlowJsonInput = z.record(z.string(), z.unknown());

/**
 * POST .../scenarios/generate — mirror of the orchestrator service's `GenerateScenariosRequest`.
 * `phlo_uuid` is the agent id (stored as `agent_id` in AO's own tables).
 * `account_id` is NOT in the body: like the orchestrator service (which reads the API-gateway-injected
 * `auth-id` header) AO resolves the account from the auth context at the route
 * layer (Phase 4), so this body stays byte-compatible with the console's.
 */
export const GenerateScenariosRequest = z.object({
  flow_json: FlowJsonInput,
  phlo_uuid: z.string().min(1),
  max_scenarios: z.number().int().min(1).max(100).default(50),
  test_case_generation_instructions: z.string().default(""),
  simulation_mode: SimulationMode.default("stress"),
});
export type GenerateScenariosRequest = z.infer<typeof GenerateScenariosRequest>;

/**
 * POST .../scenarios/run — mirror of the orchestrator service's `RunScenariosRequest`. Selects
 * already-generated scenarios by id. (Phase 4 may also accept inline scenario
 * dicts for AO-native callers; that's an additive superset, not a change here.)
 */
export const RunScenariosRequest = z.object({
  flow_json: FlowJsonInput,
  phlo_uuid: z.string().min(1),
  scenario_uuids: z.array(z.string()).min(1).max(100),
  max_turns: z.number().int().min(1).max(200).default(25),
  simulation_mode: SimulationMode.default("stress"),
});
export type RunScenariosRequest = z.infer<typeof RunScenariosRequest>;

/** POST .../scenarios/batch-delete — mirror of the orchestrator service's `DeleteScenariosRequest`. */
export const DeleteScenariosRequest = z.object({
  uuids: z.array(z.string()).min(1).max(200),
});
export type DeleteScenariosRequest = z.infer<typeof DeleteScenariosRequest>;

/** PATCH .../runs/:run_uuid/rename — mirror of the orchestrator service's `RenameSimulationRunRequest`. */
export const RenameSimulationRunRequest = z.object({
  name: z.string().min(1).max(255),
});
export type RenameSimulationRunRequest = z.infer<typeof RenameSimulationRunRequest>;

// ── Scenario (matches the worker's SimulationScenario, models.go L44-64) ───────

export const ScenarioPersona = z.object({
  personality: z.string(),
  emotional_state: z.string(),
  behavioral_traits: z.array(z.string()),
  details: z.record(z.string(), z.unknown()),
});
export type ScenarioPersona = z.infer<typeof ScenarioPersona>;

/** One node's mocked outcome in `world_state`. All fields are optional: the writer
 *  only emits `outcome`/`data`/`action_mocks` when non-empty, so a valid entry can
 *  carry just one of them (e.g. `{ outcome }` or `{ action_mocks }`). The runner
 *  defaults a missing `data` to `{}` and a missing `outcome` to the node default. */
export const WorldStateEntry = z.object({
  outcome: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional().default({}),
  action_mocks: z.record(z.string(), z.unknown()).optional(),
});
export type WorldStateEntry = z.infer<typeof WorldStateEntry>;

export const InterruptionConfig = z.object({ enabled: z.boolean(), probability: z.number() });
export const STTNoiseConfig = z.object({ enabled: z.boolean(), severity: z.enum(["light", "medium", "heavy"]) });
export const NonAnswerConfig = z.object({ enabled: z.boolean(), probability: z.number() });

/**
 * A single simulation scenario — the canonical, POST-`validate_and_fix` shape the
 * WRITER produces (Phase 1.5) and the serializer enqueues (Phase 2). `world_state`
 * is a DICT keyed by node id (NOT the array the writer emits — that conversion is
 * `validate_and_fix`'s job). `.passthrough()` lets AO-only fields the worker
 * ignores (e.g. `eval_metadata`, `coverage_key`) ride along without being dropped.
 */
export const Scenario = z
  .object({
    id: z.string(),
    name: z.string(),
    persona: ScenarioPersona,
    goal: z.string(),
    language: z.string(),
    interruption: InterruptionConfig,
    stt_noise: STTNoiseConfig,
    non_answer: NonAnswerConfig,
    world_state: z.record(z.string(), WorldStateEntry).default({}),
    start_node_params: z.record(z.string(), z.unknown()).default({}),
    max_turns: z.number().int().min(1).max(200).default(25),
    tags: z.array(z.string()).default([]),
  })
  .passthrough();
export type Scenario = z.infer<typeof Scenario>;

// ── flow_json boundary gate ────────────────────────────────────────────────────

/** Thrown when `flow_json` can't be normalized into a structurally-valid flow.
 *  Routes map this to a 400 (it's caller error, not a server fault). */
export class FlowJsonError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FlowJsonError";
    this.cause = cause;
  }
}

/**
 * Validate + canonicalize an incoming `flow_json` in one step. `normalizeFlow`
 * folds either accepted shape into `CanonicalFlow` and throws (a ZodError from
 * `CanonicalFlow.parse`) on a true structural problem — e.g. no nodes. We wrap
 * that in a typed `FlowJsonError` so the route can answer 400 with a clean
 * message instead of leaking a raw ZodError. The returned `CanonicalFlow` is
 * exactly the shape we hand to Redis for the worker's ParseFlowGraph (see the design notes).
 */
export function parseFlowJson(input: unknown): CanonicalFlow {
  try {
    return normalizeFlow(input);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new FlowJsonError(`invalid flow_json: ${detail}`, e);
  }
}
