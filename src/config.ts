import { envSchema, assertProdAuthConfigured } from "./schema.js";

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

export const authEnabled = basicAuthEnabled || liveKitAuthEnabled;

// Fail fast: a production deployment with no auth would silently expose all
// ingest + dashboard data. Dev keeps the zero-config open mode (with the loud
// startup warning in index.ts). The check itself lives in schema.ts so it
// stays unit-testable without importing this module.
assertProdAuthConfigured(config.NODE_ENV, authEnabled);
