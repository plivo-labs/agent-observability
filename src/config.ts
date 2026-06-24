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

// Whether a Postgres connection is available. When false, AO runs in STATELESS mode:
// scenario persistence, the dashboard/sessions API, evals, and alerts are all unavailable
// (their routes/sweeps are gated on this); only stateless generation + the sim worker run.
export const dbConfigured = !!config.DATABASE_URL;

// Fail fast on the contradictory config: persistence requested but no database. This preserves
// the previous "DATABASE_URL is required" behavior for the default mode (SIM_PERSIST defaults
// true), while letting an explicit stateless deploy (SIM_PERSIST=false) boot with no DB.
if (config.SIM_PERSIST && !dbConfigured) {
  console.error(
    "DATABASE_URL is required when SIM_PERSIST=true (the default). " +
      "Set DATABASE_URL, or set SIM_PERSIST=false to run AO as a stateless generator (no database).",
  );
  process.exit(1);
}

if (!dbConfigured) {
  console.warn(
    "[config] DATABASE_URL unset — running STATELESS: scenario persistence, dashboard, evals, " +
      "and alerts are disabled; only stateless generation + the sim worker are available.",
  );
}

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
