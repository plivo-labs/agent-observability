import {
  claimNextEvalSession,
  completeSessionEvalVerdicts,
  failSessionEvalVerdicts,
  getSessionEvalSource,
} from "../db.js";
import { evaluateIngestedSession, type AgentConfig } from "./integration/session-evals.js";

// ── Eval sweeper ──────────────────────────────────────────────────────────────
//
// Time-driven, DB-backed loop that judges INGESTED sessions — the counterpart
// to a request/response eval endpoint. Every SWEEP_INTERVAL_MS it drains the
// backlog: claim a session that carries an agent config and has no verdicts yet
// (claimNextEvalSession is atomic — INSERT … ON CONFLICT DO NOTHING, so a second
// sweeper degrades to wasted work, never a double-judge), run the judges, store
// the verdicts. A deterministic judge failure (e.g. a provider content policy
// rejecting the transcript) is recorded as a terminal error, NOT retried — so
// one poison session can never block the backlog the way a shared queue would.
// All state is Postgres, so progress survives restarts.

export const EVAL_SWEEP_INTERVAL_MS = 20_000;
const MAX_PER_SWEEP = 20; // bound the work per tick so one sweep can't run unbounded

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/** Judge one claimed session end-to-end. Returns false on a terminal failure. */
async function judgeClaimed(sessionId: string): Promise<boolean> {
  const source = await getSessionEvalSource(sessionId);
  if (!source) {
    // Config/session vanished between claim and read — release as error so it
    // isn't reclaimed forever.
    await failSessionEvalVerdicts(sessionId, "eval source not found");
    return false;
  }
  try {
    const rawReport = (source.rawReport ?? {}) as { events?: unknown };
    const events = Array.isArray(rawReport.events) ? (rawReport.events as any[]) : [];
    const verdicts = await evaluateIngestedSession(source.config as AgentConfig, events);
    await completeSessionEvalVerdicts(sessionId, verdicts as unknown as Record<string, unknown>);
    const nodes = verdicts.node_evaluations.length;
    console.log(`[evals] judged session=${sessionId} nodes=${nodes}`);
    return true;
  } catch (e) {
    // Node-judge failure after its own retries is terminal here — the same
    // input would fail identically, so DLQ-style record it and move on.
    await failSessionEvalVerdicts(sessionId, (e as Error).message);
    console.error(`[evals] eval_error session=${sessionId}: ${(e as Error).message}`);
    return false;
  }
}

export async function runEvalSweepOnce(): Promise<void> {
  if (sweeping) return; // re-entrancy guard: a slow sweep can't stack
  sweeping = true;
  try {
    for (let i = 0; i < MAX_PER_SWEEP; i++) {
      const sessionId = await claimNextEvalSession();
      if (!sessionId) break; // backlog drained
      await judgeClaimed(sessionId);
    }
  } catch (e) {
    console.error(`[evals] sweep failed: ${(e as Error).message}`);
  } finally {
    sweeping = false;
  }
}

export function startEvalSweeper(): void {
  if (timer) return;
  void runEvalSweepOnce();
  timer = setInterval(() => void runEvalSweepOnce(), EVAL_SWEEP_INTERVAL_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  console.log(`[evals] sweeper started (every ${EVAL_SWEEP_INTERVAL_MS / 1000}s)`);
}

export function stopEvalSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
