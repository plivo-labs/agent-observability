import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().default(9090),

  // Basic auth (optional — if both set, all routes require basic auth)
  AGENT_OBSERVABILITY_USER: z.string().optional(),
  AGENT_OBSERVABILITY_PASS: z.string().optional(),

  // Escape hatch: allow the server to boot with NO authentication configured
  // (neither basic nor LiveKit). Off by default so a misconfigured deploy
  // fails fast instead of silently exposing every route; set true only for
  // local dev / a trusted private network.
  ALLOW_UNAUTHENTICATED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

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
  // Eval sweeper: judges ingested sessions that carry an agent config.
  // "inline" runs it in the API process (zero-config single container);
  // set "off" on the API when the dedicated worker runs it, so exactly one
  // sweeper is active.
  // One flag, read by BOTH processes, so the "who runs the eval sweep" state is
  // unrepresentable-if-invalid: "inline" → the API runs it; "worker" → the
  // dedicated worker runs it; "off" → neither. Exactly one (or zero) sweepers,
  // no cross-process coordination needed.
  EVAL_SWEEPER: z.enum(["inline", "worker", "off"]).default("inline"),

  // Event-kick: judge a session the instant its ingest completes instead of
  // waiting for the next EVAL_SWEEP poll tick + settle window. Only fires in
  // the process that runs the sweeper inline (EVAL_SWEEPER=inline); the 20s
  // poller remains the safety net and covers anything the kick skips. "off"
  // reverts to poll-only without redeploying (a latency-optimization kill
  // switch; it never changes WHAT gets judged, only HOW SOON).
  EVAL_EVENT_KICK: z.enum(["on", "off"]).default("on"),

  // ── Eval sweeper concurrency / throughput (consul-tunable) ──────────────────
  // These were compile-time constants; surfaced as env so throughput can be
  // dialed from consul without a redeploy. IMPORTANT: the true provider ceiling
  // is EVAL_MAX_CONCURRENT_JUDGE_CALLS — a GLOBAL semaphore shared by BOTH the
  // poller and the event-kick. Every session fans out ~12-13 judge calls through
  // it, so raising the session/kick caps WITHOUT raising this does nothing.
  // Size this against the judge LLM endpoint's rate limit; overshooting just
  // trades throughput for 429s → retries. Defaults preserve today's behavior.
  // Sessions judged concurrently within one poll sweep.
  EVAL_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(3),
  // Sessions the ingest event-kick judges at once before deferring the rest to
  // the poller (burst backpressure).
  EVAL_MAX_CONCURRENT_KICKS: z.coerce.number().int().positive().default(3),
  // Global cap on simultaneous LLM judge calls across ALL sessions — the real
  // throughput ceiling. Raise this TOGETHER with the session/kick caps.
  EVAL_MAX_CONCURRENT_JUDGE_CALLS: z.coerce.number().int().positive().default(10),
  // Max sessions claimed per poll tick (bounds one sweep's work).
  EVAL_MAX_PER_SWEEP: z.coerce.number().int().positive().default(20),
  // Poll interval (ms) between eval sweeps.
  EVAL_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),

  // Goal analyzer (post-session LLM judging of goal: tags). Placement
  // mirrors ALERT_SWEEPER; the analyzer is additionally a no-op unless the
  // configured LLM provider has a key. It judges through the shared LLM stack
  // (runGoalJudge → completeJSON) on the "judge" role, so the judge model comes
  // from JUDGE_MODEL (below) — there is no goals-specific model knob.
  GOAL_ANALYZER: z.enum(["inline", "off"]).default("inline"),

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

  // Sim persistence mode. Selects whether AO writes its ao_sim_* tables:
  //   • true  (default) — PERSISTENT: generated scenarios land in ao_sim_scenario, run results
  //     in ao_sim_run / ao_sim_run_scenario (OSS: AO's own Postgres via AUTO_MIGRATE; managed:
  //     pre-created tables in the shared core DB — see src/db-probe.ts). Needs DATABASE_URL.
  //   • false           — STATELESS engine: AO streams scenarios + emits run events to Redis but
  //     writes NO database. No DB needed.
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
  // SQS consumer fan-out: the number of independent worker loops the consumer runs, i.e. the max
  // scenarios processed concurrently per worker process. Each worker polls SQS independently and
  // processes one message at a time (see src/sim-engine/queue/consumer.ts), so N scenarios stay in
  // flight regardless of how SQS batches deliveries — the analogue of cx-sqs-worker's N goroutines.
  // Size against downstream capacity: each concurrent scenario is a full /turn loop + LLM eval, so
  // raise this (per deploy) only as far as the agent runtime + LLM/judge endpoints can absorb.
  SIM_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),

  // Hard ceiling on scenarios one generate request may ask for. The request
  // schema allows up to 100, but the default policy caps it at 50 (a single
  // request fans out to ~max_scenarios parallel writer LLM calls, so this bounds
  // the per-request LLM cost). A request over the cap is rejected with 400.
  // Raise via env up to 100 if a deployment needs it.
  MAX_SCENARIOS_PER_REQUEST: z.coerce.number().int().positive().max(100).default(50),
  // Concurrent scenario-generation requests allowed per process. Each request
  // is an expensive multi-call LLM fan-out, so this stops a burst from
  // multiplying into unbounded spend; requests over the limit get 429.
  GEN_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  // Interval (ms) between SSE keep-alive heartbeats emitted while the generator
  // is silent (planner + writer LLM calls run for tens of seconds with no
  // events). This MUST stay well UNDER the downstream Redis peer's idle-reset
  // window: the aiassist relay mirrors each heartbeat into a Redis stream via
  // XADD, and a gap longer than the peer's idle timeout (~10s on the shared
  // cluster ELB) gets the connection reset by peer → "Scenario generation
  // failed." Default 5000 keeps every relay connection active inside that window.
  SIM_GEN_HEARTBEAT_MS: z.coerce.number().int().positive().default(5000),
});
