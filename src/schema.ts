import { z } from "zod";
import { SMOKE_CAP_FALLBACK } from "./sim-engine/gen/combos.js"; // pure data leaf — safe at env-parse time

/**
 * A reasoning-effort env knob, parsed straight into the value the provider accepts.
 *
 * Operators may write `inherit`, which is NOT a provider value — it means "send no
 * `reasoning_effort` at all and let the deployment's own default apply". That escape hatch
 * exists because an explicit effort can be REJECTED by a deployment ("none" is not universally
 * valid across gpt-5.x), and a rejected enum 400s every call on that path.
 *
 * The sentinel is collapsed HERE, at the boundary, so `config.*_REASONING_EFFORT` is already
 * `"none" | "low" | "medium" | "high" | undefined` — the exact shape the wire takes. A role
 * that reads the config value therefore CANNOT ship `"inherit"` to a provider; it is
 * unrepresentable past this point rather than something each call site has to remember to
 * translate. An invalid value still fails at boot, not per-request.
 *
 * @param fallback the effort when the var is unset. "inherit" => omit the parameter.
 */
const reasoningEffort = (fallback: "inherit" | "none" | "low" | "medium" | "high") =>
  z
    .enum(["inherit", "none", "low", "medium", "high"])
    .default(fallback)
    .transform((v) => (v === "inherit" ? undefined : v));

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
  // Per-session SPEND ceiling (the caps above bound the rate, not the bill):
  // judge at most this many nodes per session, keeping the busiest by turn
  // count. Each judged node costs ~5 LLM calls, so without this a max-size
  // config (150 clamped nodes) whose transcript touches every node fans
  // ~760 judge calls out of ONE ingested session. Conversation/goal judges
  // still see the full transcript regardless.
  EVAL_MAX_JUDGED_NODES: z.coerce.number().int().positive().default(30),

  // Eval sweeper placement: judges ingested sessions that carry an agent
  // config. 'inline' (default) runs it in the API; 'worker' in the dedicated
  // worker; 'off' disables ingest-eval everywhere.
  EVAL_SWEEPER: z.enum(["inline", "worker", "off"]).default("inline"),

  // Event-kick: judge a session the instant its ingest completes instead of
  // waiting for the next poll. Only fires in the process that runs the sweeper
  // inline (EVAL_SWEEPER=inline); the 20s poller is the backstop. 'on' default;
  // 'off' falls back to poll-only (a latency switch — never changes WHAT gets
  // judged, only HOW SOON).
  EVAL_EVENT_KICK: z.enum(["on", "off"]).default("on"),


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

  // Per-role RATE-LIMIT fallback. When a call's retries are exhausted by 429s and
  // one of these is set, completeJSON spends its last attempt on this model instead
  // of failing. Absent = off, so the feature ships inert.
  //
  // Sized for the prod Luna cutover: gpt-5.6-luna runs on 2,500K TPM per region,
  // above p99.9 but BELOW the observed peak minute (3,547K, us-east-1), so a few
  // minutes a week will throttle. gpt-5.5 sits on the same Azure resources with
  // 3,718K quota that goes largely idle after the cutover — real spare capacity next
  // to the constrained deployment. Retry-After (llm/retry-after.ts) covers a
  // TRANSIENT limit; this covers an EXHAUSTED window, where waiting cannot help.
  //
  // Set these to a DEPLOYMENT name, not a model id — same as the knobs above. A wrong
  // name surfaces as DeploymentNotFound only when the fallback fires, i.e. exactly
  // when you need it to work.
  //
  // JUDGE_MODEL_FALLBACK carries a known cost, accepted deliberately. Judges are the
  // bulk of this service's token volume (~71% of a measured run), so once JUDGE_MODEL
  // is on Luna they are also the workload most likely to exhaust its 2,500K and take
  // this path. When they do:
  //   1. Verdict rows do not record which model judged them, so a run whose judges
  //      switched mid-way yields a MIXED verdict set that is invisible in the data.
  //      Judges are calibrated against gpt-5.5 at effort "low", so a Luna verdict and
  //      a 5.5 verdict are not the same measurement. The real fix is persisting the
  //      model per verdict (a DB column); nothing does that today.
  //   2. The savings shrink: a fallen-back judge call is billed at gpt-5.5 rates.
  // Judges also have a recovery path that loses nothing — eval-sweeper.ts treats a 429
  // as transient, keeps the claim, and re-runs the whole session later — so setting
  // this trades verdict consistency for latency. completeJSON logs a loud
  // comparability warning on every judge fallback so the consequence is never silent.
  JUDGE_MODEL_FALLBACK: z.string().optional(),
  SIMULATOR_MODEL_FALLBACK: z.string().optional(),
  GENERATOR_MODEL_FALLBACK: z.string().optional(),

  // Reasoning effort for the judge role, sent as `reasoning: {effort}` on the
  // Responses API. Defaults to "none" for reference-engine parity: cx-sqs-worker
  // pins effort "none" in prod (config/env.ctmpl:92) and AO's per-judge output
  // caps (1500-5000) are copied verbatim from that engine. Those caps were sized
  // for VISIBLE output only — at any higher effort the model's invisible reasoning
  // tokens bill against the same max_output_tokens budget, long sessions truncate
  // into status="incomplete" reason="max_output_tokens", all 3 retries fail
  // identically, and the session's evals are lost (prod ap-south-1, 2026-07-14).
  // AO never sent this parameter, so every verdict to date inherited whatever the
  // model's default effort was. Raise it only together with the output caps.
  // "inherit" omits the parameter entirely (the pre-#114 wire shape) — the only
  // way to express "let the deployment's own default decide", needed because an
  // explicit value can be REJECTED by a deployment ("none" is not universally
  // valid across gpt-5.x deployments) and a rejected enum 400s every judge call.
  JUDGE_REASONING_EFFORT: reasoningEffort("none"),

  // Judge prompts come from the ao_judges registry (seeded byte-identical to
  // the shipped constants). "false"/"0" reverts to the in-code prompts — the
  // instant rollback lever for the registry cutover; behaviour is identical
  // while the seed matches source (enforced by the parity test).
  JUDGES_FROM_DB: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),

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
  // Scenario-generation model. Default gpt-5.5 matches the deployment name the managed
  // deployment's dedicated AO Azure resources actually host. It was previously "gpt-5.5-1",
  // a deployment on the LEGACY SHARED Vibe resource that the dedicated AO resources do NOT
  // host — so the default could only ever resolve to an Azure DeploymentNotFound there. The
  // managed config always sets this key explicitly, which is why the wrong default stayed
  // invisible; it only surfaced if the key went missing. For a non-Azure deploy, override +
  // point OPENAI_BASE_URL at the endpoint.
  SIM_EVAL_SCENARIO_GENERATION_MODEL: z.string().default("gpt-5.5"),

  // Reasoning effort for the two generation LLM calls, sent as `reasoning: {effort}` on the
  // Responses API (generation runs with OPENAI_API_MODE=responses on the managed deployment).
  // Independent knobs because the roles do different work: the planner does the genuinely hard
  // flow-comprehension thinking, while the writer executes an already-fixed plan (closer to
  // transcription than problem-solving). Both default to "inherit" — the parameter is not sent
  // and the deployment's own default applies, i.e. byte-identical to the pre-existing wire
  // shape — so merging this changes nothing until an operator opts in via config.
  //
  // Calibration note before you reach for these: an equivalent planner dial was already A/B'd
  // on the reference engine (aiassist PR #102) and came back a NULL RESULT — identical latency
  // and identical output-token counts across default/low/none, because planner latency there was
  // bound by output-token THROUGHPUT (~90 tok/s), not by reasoning spend. The writer dial was
  // never measured. Expect the planner knob to be inert and treat the writer knob as the
  // untested one. Neither is a substitute for choosing a faster-output model.
  //
  // Unlike the judge caps, raising effort here cannot truncate: the planner cap is generous
  // (PLANNER_MAX_OUTPUT_TOKENS) and the writer runs uncapped (maxTokens:null, streaming).
  SIM_EVAL_PLANNER_REASONING_EFFORT: reasoningEffort("inherit"),
  SIM_EVAL_WRITER_REASONING_EFFORT: reasoningEffort("inherit"),

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

  // Multi-tenant hardening for the scenario-library MUTATING routes (delete single/batch/
  // by-agent). Tenant scope comes from the gateway-injected `auth-id` header; when this flag
  // is true a request WITHOUT that header is rejected (400) instead of running unscoped —
  // unscoped means the delete matches rows across every tenant. Default false preserves
  // single-tenant/OSS behavior (no gateway, no header, no scoping). Set "true" on
  // multi-tenant deploys where AO's tables live in a shared database.
  SIM_REQUIRE_TENANT_HEADER: z
    .string()
    .default("false")
    .transform((v) => v !== "false" && v !== "0"),

  // SSRF-guard escape hatch for alert webhooks (src/net/public-url.ts). Comma-separated
  // entries, each an exact hostname, an IP literal, or an IPv4 CIDR — receivers matching an
  // entry skip the public-address requirement (delivery to internal hosts, the pre-guard
  // behavior, but by explicit operator opt-in only). Empty (default) = strict guard for all.
  WEBHOOK_URL_ALLOWLIST: z.string().optional(),

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
  // {LIVEKIT_SIM_TURN_URL}/v1/simulation/turn. Required for the run engine
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
  // Reasoning effort for the UserSimulator call. Separate from the generation knobs because the
  // simulator is the one role forced onto Chat Completions (user-simulator.ts pins apiMode:"chat"
  // for cx-sqs parity), so it is billed and timed per simulated TURN — the effort choice there
  // multiplies across a whole conversation rather than applying once per generate request.
  // Defaults to "inherit" (parameter omitted = today's wire shape).
  //
  // Historically this knob could not exist: the Chat Completions path never forwarded the
  // parameter at all, so a reasoning model configured here silently ran at the deployment's
  // default effort on every turn. That gap is closed in this change (see providers/openai.ts).
  //
  // KEEP THE DEFAULT AT "inherit" (= omit). Verified reference behaviour, 2026-08-05:
  // cx-sqs pins DefaultReasoningEffort="none" (config/env.ctmpl:92), but only its RESPONSES
  // builder reads it — buildChatCompletionsBody has no reasoning key at all, and
  // user_simulator.go forces APIFormatChatCompletions. So the reference's simulated caller
  // sends NO effort, and prod AO has always matched it (main's Chat path dropped the
  // parameter, and this key did not exist there). Defaulting to a real effort here would
  // silently change every simulation's latency and spend on every environment at once.
  //
  // Tuning a specific model is therefore a per-environment CONSUL decision, not a code
  // default — e.g. a deployment whose own default effort is expensive (measured on
  // gpt-5.6-luna: ~1.9x the per-turn latency of gpt-5.5, widening with turn index) is fixed
  // by setting this to "none"/"low" for THAT environment, verifiable via the
  // `reasoning_tokens=` field on the `[llm] usage label=user_sim` line.
  SIM_USER_REASONING_EFFORT: reasoningEffort("inherit"),
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
  // Smoke-mode unit caps (aiassist parity: VIBE_AGENT_SMOKE_CAP_DEFAULT/HARD were
  // 20/50). A smoke run yields ONE scenario per planner-emitted smoke unit, so the
  // cap bounds both the planner prompt ("emit at most N units") and the allocator
  // (lowest-priority overflow units are dropped). `max_scenarios` stays a hint for
  // smoke — the unit count governs, exactly like aiassist. DEFAULT applies when the
  // request carries no `smoke_cap`; HARD is the absolute per-request ceiling.
  // Kill-switch for mid-stream scenario emission: when true (default) each scenario
  // streams the moment its item completes in the writer's LLM token stream; "false"
  // restores chunk-granular emission (the pre-incremental behavior). Same scenarios
  // either way — only WHEN they surface changes. (Text deltas exist only on the
  // OpenAI Responses streaming path; other providers fall back automatically.)
  SIM_GEN_INCREMENTAL: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  // Planner-output cache TTL (ms). The planner is deterministic in its inputs and is
  // the slowest generation phase; the vibe rerun loop re-requests the SAME flow, so a
  // hit skips ~50s of planning per rerun (and keeps the same smoke units across the
  // loop). A hit only ever reuses a byte-identical request's plan. 0 disables.
  SIM_GEN_PLANNER_CACHE_TTL_MS: z.coerce.number().int().min(0).default(900_000),
  SMOKE_CAP_DEFAULT: z.coerce.number().int().positive().max(100).default(SMOKE_CAP_FALLBACK),
  SMOKE_CAP_HARD: z.coerce.number().int().positive().max(100).default(50),
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
