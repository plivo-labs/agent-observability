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

  // Postgres
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTO_MIGRATE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Simulation engine LLM (optional — OpenAI-compatible Chat Completions API).
  // When SIM_LLM_API_KEY is set, /api/simulations runs real persona↔agent
  // conversations + an LLM judge; otherwise it returns prompt-derived demo data.
  SIM_LLM_API_KEY: z.string().optional(),
  SIM_LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
  SIM_LLM_MODEL: z.string().default("gpt-4o-mini"),

  // Azure OpenAI for Simulate generation (alternative to SIM_LLM_*). When the
  // endpoint + key are set, the sim engine generates real persona↔agent
  // conversations via Azure (api-key header + deployment URL), so Simulate is no
  // longer demo. Reuses the same Azure account Truman uses for judging.
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().default("2024-12-01-preview"),
  AZURE_OPENAI_DEPLOYMENT: z.string().default("gpt-4.1-mini"),

  // Truman caller (optional — real LiveKit/PSTN calls for the Live module).
  // When TRUMAN_API_URL + TRUMAN_API_TOKEN are set, Live places real calls via
  // Truman's API (and Truman judges the real transcript); otherwise Live runs
  // the demo/LLM shell. Real dialing also needs Truman's caller worker running.
  TRUMAN_API_URL: z.string().optional(),
  TRUMAN_API_TOKEN: z.string().optional(),
  TRUMAN_JUDGE_MODEL: z.string().default("gpt-4.1-mini"),
  // Persona voice for provisioned Truman personas; empty → Truman's configured default.
  TRUMAN_DEFAULT_VOICE_ID: z.string().default(""),

  // S3 configuration (optional — when set, recordings are uploaded to S3)
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_PREFIX: z.string().default("recordings"),
});
