/**
 * Stage 0.3 manual smoke test — proves `completeJSON` actually reaches the
 * configured real provider, validates against a zod schema, and reports usage.
 * NOT part of CI (needs a live API key).
 *
 * Run (key stays in YOUR shell — don't commit it):
 *   LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... \
 *     DATABASE_URL=postgres://observability:observability@localhost:5433/agent_observability \
 *     bun run scripts/llm-smoke.ts
 *
 * OpenAI instead:
 *   LLM_PROVIDER=openai OPENAI_API_KEY=sk-... [OPENAI_BASE_URL=...] DATABASE_URL=... bun run scripts/llm-smoke.ts
 */
import { z } from "zod";
import { completeJSON } from "../src/llm/index.js";

const schema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  reason: z.string(),
});

const res = await completeJSON({
  schema,
  role: "judge",
  system: "You are a strict sentiment classifier.",
  prompt: "Classify the sentiment of this message: 'I love how fast the new dashboard is!'",
});

console.log("✓ provider reached + output schema-valid:", res.data);
console.log("  usage:", res.usage, "attempts:", res.attempts);
process.exit(0);
