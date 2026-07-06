/**
 * Conversation-goal analyzer: a background sweep (same placement model as
 * the alert sweeper) that claims ended sessions carrying goal:<text>
 * tags, judges each against the transcript with one LLM call per
 * session, and writes per-goal verdicts into session_external_evals
 * (source='goal').
 *
 * The judging goes through the repo's own provider-neutral LLM stack
 * (runGoalJudge → completeJSON): it honors LLM_PROVIDER / OPENAI_BASE_URL /
 * JUDGE_MODEL, has per-attempt timeout + retry, and reconciles verdicts to
 * goals BY NAME (not array position), so a reordered model response can't
 * mis-attribute a verdict. A hard no-op unless an LLM provider key is
 * configured (or a provider is injected — tests pass MockLLM). Failures are
 * marked on the tracking row and retried by later sweeps up to MAX_ATTEMPTS
 * (see src/goals/db.ts for the claim protocol).
 */
import type { LlmProvider } from "../llm/index.js";
import { config } from "../config.js";
import { isLlmConfigured } from "../sim-engine/config.js";
import { runGoalJudge } from "../evals-engine/judges/goal-judge.js";
import type { ConversationInput, GoalInput } from "../evals-engine/types.js";
import { startSweeper, type SweeperHandle } from "../sweeper-loop.js";
import { renderTranscript } from "./extract.js";
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

/** True when the configured LLM provider has a key — the analyzer is a hard
 *  no-op otherwise (goal judging needs an LLM). */
function analyzerEnabled(): boolean {
  return isLlmConfigured(config.LLM_PROVIDER, config.ANTHROPIC_API_KEY, config.OPENAI_API_KEY);
}

async function analyzeSession(sessionId: string, provider?: LlmProvider): Promise<void> {
  const { goals, chatHistory } = await loadGoalSession(sessionId);
  if (goals.length === 0) {
    await markGoalAnalysisError(sessionId, "no goals found at analysis time");
    return;
  }
  const { text, truncated } = renderTranscript(chatHistory);
  if (!text) {
    // Nothing to judge — never send an empty transcript (the judge would
    // score every goal unmet). Mark it and let MAX_ATTEMPTS retire it.
    await markGoalAnalysisError(sessionId, "empty transcript");
    return;
  }

  // Adapt the live-session shape to the eval engine's goal judge, which already
  // does name-keyed reconciliation (missing goal → not-achieved) and rides the
  // provider-neutral completeJSON (timeout + retry).
  const goalInputs: GoalInput[] = goals.map((g) => ({
    goal_name: g.name,
    goal_instructions: g.description,
    flow_goal_id: 0,
  }));
  const ctx: ConversationInput = {
    flow_name: "",
    global_prompt: "",
    nodes: [],
    goals: goalInputs,
    full_transcript: truncated
      ? `[transcript truncated: earlier turns omitted]\n${text}`
      : text,
  };

  const { data } = await runGoalJudge(goalInputs, ctx, provider);

  // runGoalJudge returns one verdict per input goal, in input order and keyed
  // by name — so zip with the original GoalSpec to recover each description.
  await completeGoalAnalysis(
    sessionId,
    goals.map((goal, i) => {
      const verdict = data.goals[i];
      return {
        name: goal.name,
        description: goal.description,
        met: verdict.achieved,
        reasoning: verdict.reason,
        whatWentWrong: verdict.achieved ? null : verdict.technical_reason || null,
      };
    }),
  );
}

let sweeping = false;

export async function runGoalSweepOnce(deps?: { provider?: LlmProvider }): Promise<void> {
  // A no-op unless an LLM is reachable (configured provider key, or an injected
  // provider in tests). Prevents a 30s error-loop on an unconfigured deploy.
  if (!deps?.provider && !analyzerEnabled()) return;
  if (sweeping) return;
  sweeping = true;
  try {
    const sessions = await claimGoalSessions(BATCH_LIMIT);
    for (let i = 0; i < sessions.length; i += ANALYZE_CONCURRENCY) {
      const chunk = sessions.slice(i, i + ANALYZE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (sessionId) => {
          try {
            await analyzeSession(sessionId, deps?.provider);
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

let handle: SweeperHandle | null = null;

export function startGoalAnalyzer(): void {
  if (handle) return; // idempotent — never stack two timers
  if (!analyzerEnabled()) {
    console.log("[goals] no LLM provider key configured — goal analyzer disabled");
    return;
  }
  console.log(`[goals] analyzer starting — model=${config.JUDGE_MODEL || "(provider default)"}`);
  handle = startSweeper(() => runGoalSweepOnce(), GOAL_SWEEP_INTERVAL_MS, "goals");
}

export function stopGoalAnalyzer(): void {
  handle?.stop();
  handle = null;
}
