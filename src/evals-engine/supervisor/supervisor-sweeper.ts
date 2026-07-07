// Supervisor sweeper — periodically re-judges done verdicts and records misflags.
//
// Counterpart to the eval sweeper: claim a done-but-unreviewed verdict, rebuild
// its input (transcript + node prompts), re-decide each judge axis with an
// independent model (N-vote), and store agreement + a suggested prompt fix on
// disagreement. Fired axes are always reviewed; non-fired axes are sampled
// (EVAL_REVIEW_SAMPLE_RATE) so under-fires are still caught. All state in Postgres.

import { config } from "../../config.js";
import { sanitizeForLog } from "../../response.js";
import { startSweeper, type SweeperHandle } from "../../sweeper-loop.js";
import { getSessionEvalSource } from "../db.js";
import { eventsFromChatHistory } from "../eval-sweeper.js";
import { buildSessionEvalInput, type AgentConfig, type SessionEvalVerdicts, type StoredEvent } from "../integration/session-evals.js";
import { buildAxisChecks } from "./axes.js";
import { reviewAxis } from "./reviewer.js";
import { claimNextReview, markReviewDone, markReviewError, pendingReviews, storeReview } from "./db.js";

const MAX_SESSIONS_PER_SWEEP = 3;
const AXIS_CONCURRENCY = 4;
const CONVERSATION_AXES = new Set([
  "bot_detection", "voicemail", "call_screening", "low_engagement", "wrong_number", "do_not_disturb", "user_sentiment",
]);

let handle: SweeperHandle | null = null;
let sweeping = false;

/** Run `tasks` with bounded concurrency. */
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function reviewOneSession(): Promise<boolean> {
  const claim = await claimNextReview();
  if (!claim) return false;
  const sessionId = claim.sessionId;
  try {
    const source = await getSessionEvalSource(sessionId);
    if (!source) { await markReviewError(sessionId, "review source not found"); return true; }

    const rawReport = (source.rawReport ?? {}) as { events?: unknown };
    let events: StoredEvent[] = Array.isArray(rawReport.events) ? (rawReport.events as StoredEvent[]) : [];
    if (events.length === 0) events = eventsFromChatHistory(source.chatHistory);
    const { input } = buildSessionEvalInput(source.config as AgentConfig, events);
    const verdicts = claim.verdicts as unknown as SessionEvalVerdicts;

    const checks = buildAxisChecks(verdicts, input);
    // Always review fired axes; sample the rest so under-fires surface too.
    const selected = checks.filter((c) => c.fired || Math.random() < config.EVAL_REVIEW_SAMPLE_RATE);
    if (selected.length === 0) { await markReviewDone(sessionId); return true; }

    let misflags = 0;
    await pool(selected, AXIS_CONCURRENCY, async (check) => {
      const transcript = CONVERSATION_AXES.has(check.axis)
        ? (input.speech_transcript || input.full_transcript)
        : input.full_transcript;
      const review = await reviewAxis(check, input.flow_name, transcript);
      await storeReview(sessionId, review, claim.observedAt);
      if (!review.agreement) misflags++;
    });

    await markReviewDone(sessionId);
    console.log(`[supervisor] reviewed session=${sanitizeForLog(sessionId)} axes=${selected.length} misflags=${misflags}`);
  } catch (e) {
    await markReviewError(sessionId, (e as Error).message);
    console.error(`[supervisor] review_error session=${sanitizeForLog(sessionId)}: ${(e as Error).message}`);
  }
  return true;
}

async function runReviewSweepOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const pending = await pendingReviews();
    if (pending > 0) console.log(`[supervisor] backlog=${pending} verdicts awaiting review`);
    for (let i = 0; i < MAX_SESSIONS_PER_SWEEP; i++) {
      const did = await reviewOneSession();
      if (!did) break; // backlog drained
    }
  } catch (e) {
    console.error(`[supervisor] sweep failed: ${(e as Error).message}`);
  } finally {
    sweeping = false;
  }
}

export function startSupervisorSweeper(): void {
  if (handle) return;
  handle = startSweeper(() => runReviewSweepOnce(), config.EVAL_REVIEW_INTERVAL_MS, "supervisor");
}

export function stopSupervisorSweeper(): void {
  handle?.stop();
  handle = null;
}
