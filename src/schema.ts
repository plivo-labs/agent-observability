import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().default(9090),

  // Basic auth (optional — if both set, all routes require basic auth)
  AGENT_OBSERVABILITY_USER: z.string().optional(),
  AGENT_OBSERVABILITY_PASS: z.string().optional(),

  // LiveKit native observability upload auth. The SDK signs Bearer JWTs with
  // these values and includes an observability.write grant.
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  // Postgres. Optional so AO can run as a STATELESS generator (the managed deployment / bring-your-own-backend)
  // with no database. It is effectively required in the default mode: config.ts fails fast if
  // SIM_PERSIST=true (the default) and DATABASE_URL is unset. Set SIM_PERSIST=false to run without it.
  // preprocess: treat an empty string (`DATABASE_URL=` in an env file) the same as unset.
  DATABASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  AUTO_MIGRATE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Alert sweeper placement. 'inline' (default) runs it inside the API
  // process — zero-config single-container deploys. Set 'off' when running
  // the dedicated worker entrypoint (bun src/worker.ts) so exactly one
  // sweeper is active.
  ALERT_SWEEPER: z.enum(["inline", "off"]).default("inline"),

  // CORS allow-list for the /api/* dashboard endpoints. Comma-separated
  // origins (e.g. "https://obs.example.com,http://localhost:5173"). In
  // production the dashboard is served same-origin so CORS isn't needed;
  // set this when the dashboard runs on a different origin. Defaults to
  // "*" (any origin) for zero-config local dev.
  CORS_ALLOWED_ORIGINS: z.string().default("*"),

  // S3 configuration (optional — when set, recordings are uploaded to S3)
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_PREFIX: z.string().default("recordings"),

  // ── LLM provider (used by the simulation scenario generator) ────────────────
  // Provider-neutral: src/llm/completeJSON dispatches to the adapter named here.
  // Keys are read only when the matching provider is selected. OPENAI_BASE_URL
  // lets the OpenAI adapter target Azure OpenAI / OpenRouter / a local server
  // (this is how the managed deployment's gpt-5.5-1 endpoint is wired in — see plan.md Phase 1).
  LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // API root for the OpenAI adapter (the part BEFORE /chat/completions or /responses).
  // Vanilla OpenAI: https://api.openai.com/v1. An OpenAI-compatible gateway (Azure
  // "/openai/v1", OpenRouter, a local server) sets its own root here.
  OPENAI_BASE_URL: z.string().optional(),
  // Wire-format the OpenAI adapter speaks. Both are standard OpenAI APIs:
  //   • "chat"      (default) — Chat Completions: POST {base}/chat/completions, `messages` + response_format.
  //   • "responses"           — Responses API:    POST {base}/responses, `input` + text.format.
  // Pick "responses" for gateways that only expose the Responses API.
  OPENAI_API_MODE: z.enum(["chat", "responses"]).default("chat"),
  // Auth header style for the OpenAI adapter:
  //   • "bearer"  (default) — Authorization: Bearer <key>  (vanilla OpenAI / OpenRouter).
  //   • "api-key"           — api-key: <key>                (Azure-style / api-key gateways).
  OPENAI_AUTH_STYLE: z.enum(["bearer", "api-key"]).default("bearer"),

  // Per-role model overrides (empty = the adapter's built-in default). The
  // scenario generator uses the "generator" role; the sim-engine also passes an
  // explicit SIM_EVAL_SCENARIO_GENERATION_MODEL (added in Phase 0.4).
  JUDGE_MODEL: z.string().optional(),
  SIMULATOR_MODEL: z.string().optional(),
  GENERATOR_MODEL: z.string().optional(),

  // completeJSON request hardening: per-attempt timeout + retry count.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(1),

  // ── Simulation engine ───────────────────────────────────────────────────────
  // Capability-gated (see src/sim-engine/config.ts), NOT all-or-nothing:
  //   • generation needs only an LLM provider key (works with no Redis/SQS),
  //   • runs need REDIS_URL + LIVEKIT_SIM_TURN_URL (Redis is the live :RESULTS
  //     stream + the Lua completion gate),
  //   • queue (the SQS consumer) additionally needs SIM_EVAL_SQS_QUEUE_URL.
  // SIM_EVAL_SQS_QUEUE_URL is the optional run-dispatch plug-in: set it to consume
  // scenario-run messages produced by the orchestrator service (the managed deployment). AWS credentials are read
  // from the AWS SDK's standard provider chain (AWS_ACCESS_KEY_ID/_SECRET env,
  // shared config, or an instance role), NOT here — so no secret lands in this schema.
  SIM_EVAL_SQS_QUEUE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  // Prod Redis is CLUSTERED (the SIM_EVAL:{run_uuid}:* hash tags + the worker's
  // 3-key Lua completion gate only matter in cluster mode). Set true to construct
  // an ioredis Cluster client; default false = standalone (dev / dockerized E2E).
  REDIS_CLUSTER: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  AWS_REGION: z.string().optional(),
  // Scenario-generation model. Default gpt-5.5-1 matches the orchestrator service (the managed deployment). For a
  // non-Azure deploy, override + point OPENAI_BASE_URL at the endpoint.
  SIM_EVAL_SCENARIO_GENERATION_MODEL: z.string().default("gpt-5.5-1"),

  // Scenario-library persistence mode. Selects whether AO owns its own scenario store:
  //   • true  (default) — SELF-CONTAINED (OSS): each generated scenario is written to AO's
  //     own Postgres (ao_simulation_scenarios) and the library routes serve it. Needs DATABASE_URL.
  //   • false           — STATELESS generator (the managed deployment / bring-your-own-backend): AO streams
  //     scenarios but writes NO database; the host (the orchestrator service) persists what it relays. No DB needed.
  // This is the DEFAULT; the per-request `?persist=true|false` query param overrides it. Persistence
  // is impossible without a DB, so the effective value is always ANDed with DATABASE_URL being set.
  SIM_PERSIST: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),

  // ── Run engine (the ported reference-worker simulation loop) ───────────────────
  // Runs are dispatched via the SQS consumer (src/worker.ts), which drains run
  // messages produced by the orchestrator service; AO stays stateless (Redis-only, no Postgres run
  // rows). Requires SIM_EVAL_SQS_QUEUE_URL. (V1 has no in-process mode — the OSS
  // queue-free path was removed; re-add behind a driver seam when OSS lands.)
  // Redis key prefix for the run-scoped keys (FLOW_JSON / SCENARIO_EXPECTED_COUNT /
  // RESULTS / the Lua completion counters). Default SIM_EVAL matches the orchestrator service on
  // the managed deployment's shared Redis; override for an OSS deploy with its own Redis.
  SIM_REDIS_PREFIX: z.string().default("SIM_EVAL"),
  // Base URL of the agent runtime. The engine POSTs each turn to
  // {LIVEKIT_SIM_TURN_URL}/v1/simulation/session/turn. Required for the run engine
  // (Stage 2+); unset on a generation-only deploy.
  LIVEKIT_SIM_TURN_URL: z.string().optional(),
  // Optional Basic-auth credentials for the agent runtime /turn endpoint. Rendered from the
  // shared LiveKit sim secret (LiveKitSimConfig.Username/.Password) on the managed deployment;
  // empty/unset → the client sends no Authorization header (unauthenticated private network).
  LIVEKIT_SIM_TURN_USER: z.string().optional(),
  LIVEKIT_SIM_TURN_PASS: z.string().optional(),
  // The UserSimulator (simulated caller) LLM model. Falls back to the scenario
  // generation model when unset (see simEngineConfig.userSimulatorModel).
  // preprocess: treat an empty string (`USER_SIMULATOR_MODEL=` rendered from an empty secret) the
  // same as unset, so it falls back cleanly via `??` instead of slipping through as "" (which
  // would otherwise be sent as an empty model id). Mirrors DATABASE_URL above.
  USER_SIMULATOR_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Scenarios one worker process runs concurrently (SQS consumer fan-out).
  SIM_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
});
