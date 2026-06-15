import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().default(9090),

  // Runtime environment. In production at least one auth mode MUST be
  // configured or the process refuses to boot (see config.ts). 'development'
  // keeps the zero-config open mode; 'test' is used by the suites.
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Basic auth (optional — if both set, all routes require basic auth)
  AGENT_OBSERVABILITY_USER: z.string().optional(),
  AGENT_OBSERVABILITY_PASS: z.string().optional(),

  // LiveKit native observability upload auth. The SDK signs Bearer JWTs with
  // these values and includes an observability.write grant.
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  // Postgres
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTO_MIGRATE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Alert sweeper placement. 'inline' (default) runs it inside the API
  // process — zero-config single-container deploys. Set 'off' when running
  // the dedicated worker entrypoint (bun src/worker.ts) so exactly one
  // sweeper is active.
  ALERT_SWEEPER: z.enum(["inline", "off"]).default("inline"),

  // Generic job worker placement (Stage 0.4), mirrors ALERT_SWEEPER. 'inline'
  // (default) runs the job loop inside the API process for zero-config
  // single-container deploys; set 'off' when running the dedicated worker
  // (bun src/worker.ts) so jobs aren't swept twice.
  JOBS_WORKER: z.enum(["inline", "off"]).default("inline"),

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

  // ── LLM provider (Stage 0.3) ───────────────────────────────────────────────
  // Provider-neutral: the eval/simulation engines call src/llm/completeJSON,
  // which dispatches to the adapter named here. Keys are read only when the
  // matching provider is selected. OPENAI_BASE_URL lets the OpenAI adapter
  // target Azure OpenAI / OpenRouter / a local server.
  LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),

  // Per-role model overrides. Empty = the adapter's built-in default.
  JUDGE_MODEL: z.string().optional(),
  SIMULATOR_MODEL: z.string().optional(),
  GENERATOR_MODEL: z.string().optional(),

  // completeJSON request hardening.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(1),
});

/**
 * Refuse to boot a production deployment that has no authentication. In any
 * non-development environment, running wide open would silently expose all
 * ingest + dashboard data, so we fail fast instead. Development keeps the
 * zero-config open mode (with the loud warning emitted at startup).
 *
 * Pure (no side effects) and kept here so the dev/prod auth matrix is
 * unit-testable without importing config.ts, which parses real env on load.
 */
export function assertProdAuthConfigured(nodeEnv: string, hasAuth: boolean): void {
  if (nodeEnv === "production" && !hasAuth) {
    throw new Error(
      "NODE_ENV=production but no authentication is configured. Set " +
        "AGENT_OBSERVABILITY_USER/_PASS or LIVEKIT_API_KEY/_SECRET, or run " +
        "with NODE_ENV=development to allow the open (no-auth) mode.",
    );
  }
}
