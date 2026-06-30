import { config, dbConfigured } from "../config.js";

// AO Simulation Engine — config view + capability gates.
//
// The simulation feature is capability-gated, NOT all-or-nothing. Each capability
// lights up on its OWN prerequisites so an OSS install needs only what it uses:
//   • generation — an LLM provider key (no Redis/SQS required),
//   • runs        — REDIS_URL + LIVEKIT_SIM_TURN_URL (Redis is the live :RESULTS
//                   stream + the Lua completion gate),
//   • queue       — the SQS consumer (the managed deployment): consumes the orchestrator service's run messages;
//                   additionally needs SIM_EVAL_SQS_QUEUE_URL. This is the only
//                   run-dispatch path in V1 (the OSS in-process mode was removed —
//                   re-add behind a driver seam when OSS lands).
// The pure helpers below take their inputs as args (no `config` dependency) so the
// dev/prod matrix is unit-testable without importing config.ts, which parses real
// env on load. AWS credentials are intentionally NOT modelled here — the AWS SDK
// reads them from its standard provider chain.

/** True when the selected LLM provider is usable (its API key is present). */
export function isLlmConfigured(
  provider: "anthropic" | "openai",
  anthropicKey?: string,
  openaiKey?: string,
): boolean {
  return provider === "openai" ? !!openaiKey : !!anthropicKey;
}

/** True when the run engine can execute scenarios: a live-stream Redis AND a /turn endpoint. */
export function isRunEnabled(redisUrl?: string, livekitSimTurnUrl?: string): boolean {
  return !!redisUrl && !!livekitSimTurnUrl;
}

/**
 * Queue-dispatch prerequisites: an SQS queue AND Redis. Pure (no config import) and kept
 * stable so the dev/prod matrix stays unit-testable; the derived gates below compose it.
 */
export function isSimEngineEnabled(sqsQueueUrl?: string, redisUrl?: string): boolean {
  return !!sqsQueueUrl && !!redisUrl;
}

// ── Derived gates for THIS process (read once at load) ─────────────────────────

/** Scenario generation is available (an LLM provider key is configured). */
export const generationEnabled = isLlmConfigured(
  config.LLM_PROVIDER,
  config.ANTHROPIC_API_KEY,
  config.OPENAI_API_KEY,
);

/** The run engine is available (Redis live stream + a /turn endpoint). Both dispatch modes need this. */
export const runEnabled = isRunEnabled(config.REDIS_URL, config.LIVEKIT_SIM_TURN_URL);

/** The SQS consumer is enabled (SQS + Redis + a /turn endpoint). The only run-dispatch path in V1. */
export const queueDispatchEnabled =
  isSimEngineEnabled(config.SIM_EVAL_SQS_QUEUE_URL, config.REDIS_URL) && runEnabled;

/** The /api/simulation/* group is mounted when ANY capability is configured (else the group 404s). */
export const simFeatureEnabled = generationEnabled || runEnabled;

/**
 * Default scenario-library persistence for THIS process. Whether a generated scenario is written to
 * AO's own DB when a request doesn't specify `?persist=`. SELF-CONTAINED (OSS) = true; STATELESS
 * (the managed deployment / bring-your-own-backend) = false. ANDed with dbConfigured because persistence is
 * impossible without a database (config.ts already fails fast on SIM_PERSIST=true + no DB).
 */
export const scenarioPersistDefault = config.SIM_PERSIST && dbConfigured;

/**
 * Legacy gate: queue-dispatch prerequisites present (SQS + Redis). Superseded by the capability
 * gates above; retained for back-compat with callers/tests that referenced the old all-or-nothing gate.
 */
export const simEngineEnabled = isSimEngineEnabled(config.SIM_EVAL_SQS_QUEUE_URL, config.REDIS_URL);

/** Focused, typed view of the sim-engine settings, read once at startup. */
export const simEngineConfig = {
  /** SQS queue the worker drains (per environment). */
  sqsQueueUrl: config.SIM_EVAL_SQS_QUEUE_URL,
  /** Redis the worker uses for FLOW_JSON / EXPECTED_COUNT / the :RESULTS stream. */
  redisUrl: config.REDIS_URL,
  /** Whether REDIS_URL points at a Redis Cluster (prod) vs standalone (dev/E2E). */
  redisCluster: config.REDIS_CLUSTER,
  /** Region for the SQS client; AWS creds come from the SDK's default chain. */
  awsRegion: config.AWS_REGION,
  /** Scenario-generation model (default gpt-5.5-1; see plan.md Phase 1). */
  scenarioGenerationModel: config.SIM_EVAL_SCENARIO_GENERATION_MODEL,
  /** Redis key prefix (default SIM_EVAL = the orchestrator service in the managed deployment; override for OSS). */
  simRedisPrefix: config.SIM_REDIS_PREFIX,
  /** agent runtime base URL; the engine POSTs /v1/simulation/session/turn here. */
  livekitSimTurnUrl: config.LIVEKIT_SIM_TURN_URL,
  /** Optional Basic-auth creds for the /turn endpoint (empty → unauthenticated). */
  livekitSimTurnUser: config.LIVEKIT_SIM_TURN_USER,
  livekitSimTurnPass: config.LIVEKIT_SIM_TURN_PASS,
  /**
   * UserSimulator (simulated caller) LLM model. MUST be a non-reasoning chat model (cx-sqs uses
   * gpt-4.1 via the shared AZURE_VIBE_SIMULATOR_DEPLOYMENT secret). Falls back to the generation
   * model only when unset — the schema preprocess maps an empty env to undefined so the `??` fires
   * cleanly. The simulator call also forces Chat Completions (see user-simulator.ts), so a reasoning
   * model would be wrong here.
   */
  userSimulatorModel: config.USER_SIMULATOR_MODEL ?? config.SIM_EVAL_SCENARIO_GENERATION_MODEL,
  /** Scenarios run concurrently per worker process / per in-process run (fan-out bound). */
  workerConcurrency: config.SIM_WORKER_CONCURRENCY,
} as const;
