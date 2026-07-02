/**
 * Conversation-goal analyzer: a background sweep (same placement model as
 * the alert sweeper) that claims ended sessions carrying goal:<text>
 * tags, judges each against the transcript with one LLM call per
 * session, and writes per-goal verdicts into session_external_evals
 * (source='goal').
 *
 * Hard no-op unless OPENAI_API_KEY is set (or a model is injected —
 * tests and the integration suite pass MockLanguageModelV3 / fakes).
 * Failures are marked on the tracking row and retried by later sweeps
 * up to MAX_ATTEMPTS (see src/goals/db.ts for the claim protocol).
 */
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config.js";
import { renderTranscript } from "./extract.js";
import { buildGoalJudgePrompt, goalVerdictSchema } from "./prompt.js";
import {
  claimGoalSessions,
  completeGoalAnalysis,
  loadGoalSession,
  markGoalAnalysisError,
} from "./db.js";

export const GOAL_SWEEP_INTERVAL_MS = 30_000;
const BATCH_LIMIT = 10;
// Sessions are judged in small parallel chunks (same shape as the alert
// sweeper's DELIVERY_CONCURRENCY) — kept low deliberately to stay gentle
// on the LLM provider's rate limits.
const ANALYZE_CONCURRENCY = 3;

/** Same contract as the Python SDK judge helper. */
export function resolveJudgeModel(): string {
  return config.JUDGE_LLM_MODEL || config.OPENAI_MODEL || "gpt-4.1-mini";
}

function defaultModel(): LanguageModel | null {
  if (!config.OPENAI_API_KEY) return null;
  const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
  return openai(resolveJudgeModel());
}

async function analyzeSession(sessionId: string, model: LanguageModel): Promise<void> {
  const { goals, chatHistory } = await loadGoalSession(sessionId);
  if (goals.length === 0) {
    await markGoalAnalysisError(sessionId, "no goals found at analysis time");
    return;
  }
  const { text, truncated } = renderTranscript(chatHistory);

  const { object } = await generateObject({
    model,
    schema: goalVerdictSchema,
    prompt: buildGoalJudgePrompt(text, goals, truncated),
  });

  if (object.goals.length !== goals.length) {
    throw new Error(
      `model returned ${object.goals.length} verdicts for ${goals.length} goals`,
    );
  }

  await completeGoalAnalysis(
    sessionId,
    goals.map((goal, i) => ({
      name: goal.name,
      description: goal.description,
      met: object.goals[i].met,
      reasoning: object.goals[i].reasoning,
      whatWentWrong: object.goals[i].what_went_wrong,
    })),
  );
}

let sweeping = false;

export async function runGoalSweepOnce(deps?: { model?: LanguageModel }): Promise<void> {
  const model = deps?.model ?? defaultModel();
  if (!model) return;
  if (sweeping) return;
  sweeping = true;
  try {
    const sessions = await claimGoalSessions(BATCH_LIMIT);
    for (let i = 0; i < sessions.length; i += ANALYZE_CONCURRENCY) {
      const chunk = sessions.slice(i, i + ANALYZE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (sessionId) => {
          try {
            await analyzeSession(sessionId, model);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[goals] analysis failed session_id=${sessionId}: ${message}`);
            await markGoalAnalysisError(sessionId, message.slice(0, 2000));
          }
        }),
      );
    }
  } catch (err) {
    console.error(`[goals] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sweeping = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startGoalAnalyzer(): void {
  if (!config.OPENAI_API_KEY) {
    console.log("[goals] OPENAI_API_KEY not set — goal analyzer disabled");
    return;
  }
  console.log(
    `[goals] analyzer started — model=${resolveJudgeModel()}, sweeping every ${GOAL_SWEEP_INTERVAL_MS / 1000}s`,
  );
  void runGoalSweepOnce();
  timer = setInterval(() => void runGoalSweepOnce(), GOAL_SWEEP_INTERVAL_MS);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
}

export function stopGoalAnalyzer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
