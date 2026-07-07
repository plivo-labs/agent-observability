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

// ── LLM provider back-compat (pre-shared-LLM-stack deploys) ─────────────────────
// LLM_PROVIDER defaults to "anthropic", but a legacy deploy configured per the old schema
// (only OPENAI_API_KEY set, no LLM_PROVIDER) would silently flip to a provider it has no key
// for — the goal analyzer would just stop judging with one boot log. When the operator did
// NOT set LLM_PROVIDER and exactly the OpenAI key is present, infer "openai" (the legacy
// behavior) and say so. An explicit LLM_PROVIDER always wins.
if (!process.env.LLM_PROVIDER && config.OPENAI_API_KEY && !config.ANTHROPIC_API_KEY) {
  config.LLM_PROVIDER = "openai";
  console.warn(
    "[config] LLM_PROVIDER unset but only OPENAI_API_KEY is configured — using provider " +
      '"openai" (legacy compatibility). Set LLM_PROVIDER=openai explicitly to silence this.',
  );
}

// Legacy judge-model vars (JUDGE_LLM_MODEL / OPENAI_MODEL) were replaced by JUDGE_MODEL when
// the goal analyzer converged onto the shared LLM stack. Honor them as a JUDGE_MODEL fallback
// (old precedence: JUDGE_LLM_MODEL → OPENAI_MODEL) so an upgrade doesn't silently revert an
// operator's configured judge model to the provider default.
const legacyJudgeModel = process.env.JUDGE_LLM_MODEL || process.env.OPENAI_MODEL || "";
if (legacyJudgeModel && !config.JUDGE_MODEL) {
  config.JUDGE_MODEL = legacyJudgeModel;
  console.warn(
    `[config] JUDGE_LLM_MODEL/OPENAI_MODEL are deprecated — using "${legacyJudgeModel}" as ` +
      "JUDGE_MODEL for compatibility. Rename the env var to JUDGE_MODEL.",
  );
}

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
