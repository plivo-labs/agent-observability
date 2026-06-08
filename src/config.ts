import { envSchema } from "./schema.js";

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

export const s3Enabled =
  !!config.S3_BUCKET &&
  !!config.S3_ACCESS_KEY_ID &&
  !!config.S3_SECRET_ACCESS_KEY;

export const basicAuthEnabled =
  !!config.AGENT_OBSERVABILITY_USER &&
  !!config.AGENT_OBSERVABILITY_PASS;

export const liveKitAuthEnabled =
  !!config.LIVEKIT_API_KEY &&
  !!config.LIVEKIT_API_SECRET;

// When set, the Live module places REAL calls via the Truman caller API
// (Truman judges the real transcript). Otherwise Live runs the demo/LLM shell.
export const trumanEnabled =
  !!config.TRUMAN_API_URL &&
  !!config.TRUMAN_API_TOKEN;

// When set, Simulate generates real conversations via Azure OpenAI (api-key +
// deployment URL) instead of SIM_LLM / prompt-derived demo.
export const azureLlmEnabled =
  !!config.AZURE_OPENAI_ENDPOINT &&
  !!config.AZURE_OPENAI_API_KEY;
