import type { ZodType } from "zod";
import { completeJSON, type LlmProvider, type LlmUsage } from "../../llm/index.js";

// AO Eval Engine — the single LLM entry every judge uses. Replaces LiveKit's private `_LLMJudge`:
// build system+user, call the shared `completeJSON` on the "judge" role (→ JUDGE_MODEL || claude-opus-4-8,
// with retry/timeout/usage already handled), validate against the judge's Zod schema. `provider` is
// injected by tests (MockLLM); prod resolves from env.

export interface RunLlmJudgeArgs<T> {
  /** System prompt: SDK criteria body + our JSON output section (from instructions.ts). */
  system: string;
  /** User payload: the transcript slice + node context (JSON-stringified by the caller or here). */
  input: unknown;
  /** Per-judge raw-output schema. */
  schema: ZodType<T>;
  /** cx-sqs parity token caps (instruction 5000 / variable 3000 / hallucination 1500 / loop 1500 / goal 2000). */
  maxTokens: number;
  /** Strict structured-output schema (cx-sqs parity) — forces the gateway to return exact JSON. */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /** Test injection. */
  provider?: LlmProvider;
}

export interface JudgeResult<T> {
  data: T;
  usage: LlmUsage;
}

// Process-wide cap on concurrent judge LLM calls. Every judge (node + conversation + goal)
// funnels through runLlmJudge, so this is the single choke point: a big call fans out to
// nodes × 5 judges via Promise.all, and without a cap a 60-node payload fires 300 concurrent
// provider requests → 429 storms → retries → worker-side timeouts. Judges queue here instead;
// verdicts are unaffected, only scheduling. Override with JUDGE_LLM_CONCURRENCY.
const MAX_CONCURRENT_JUDGE_CALLS = (() => {
  const n = Number(process.env.JUDGE_LLM_CONCURRENCY ?? "");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 12;
})();
let activeJudgeCalls = 0;
const judgeCallWaiters: Array<() => void> = [];

async function acquireJudgeSlot(): Promise<void> {
  if (activeJudgeCalls < MAX_CONCURRENT_JUDGE_CALLS) {
    activeJudgeCalls++;
    return;
  }
  // At capacity: wait. The releaser hands its slot over without decrementing, so the
  // count can never exceed the cap (no decrement→increment window for a newcomer).
  await new Promise<void>((resolve) => judgeCallWaiters.push(resolve));
}

function releaseJudgeSlot(): void {
  const next = judgeCallWaiters.shift();
  if (next) next(); // transfer the slot to the next queued judge
  else activeJudgeCalls--;
}

export async function runLlmJudge<T>(args: RunLlmJudgeArgs<T>): Promise<JudgeResult<T>> {
  await acquireJudgeSlot();
  try {
    const res = await completeJSON({
      schema: args.schema,
      role: "judge",
      system: args.system,
      prompt: typeof args.input === "string" ? args.input : JSON.stringify(args.input),
      maxTokens: args.maxTokens,
      // Strict structured output (cx-sqs parity): the provider emits text.format/response_format json_schema so the
      // gateway returns exact JSON. Omitted → free JSON (fragile on the responses gateway).
      jsonSchema: args.jsonSchema,
      // 3 total attempts = cx-sqs metricMaxRetries (1 call + 2 reprompts).
      maxRetries: 2,
      provider: args.provider,
    });
    return { data: res.data, usage: res.usage };
  } finally {
    releaseJudgeSlot();
  }
}
