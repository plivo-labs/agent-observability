import { insertLiveKitEvaluation, sql } from "../db.js";
import { config } from "../config.js";
import {
  claimEvalSessionNow,
  claimNextEvalSession,
  completeSessionEvalVerdicts,
  countPendingEvalSessions,
  deferEvalClaimRetry,
  failSessionEvalVerdicts,
  getSessionEvalSource,
  heartbeatEvalClaim,
  type EvalClaim,
} from "./db.js";
import { sanitizeForLog } from "../response.js";
import { startSweeper, type SweeperHandle } from "../sweeper-loop.js";
import { buildSessionEvalInput, evaluateIngestedSession, type AgentConfig, type SessionEvalVerdicts, type StoredEvent } from "./integration/session-evals.js";
import { buildExternalEvalRows } from "./fan-out-rows.js";

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

// Concurrency/throughput knobs are env-configurable (consul-tunable) so they
// can be dialed without a redeploy; defaults in src/schema.ts preserve prior
// behavior. The judge-call semaphore (EVAL_MAX_CONCURRENT_JUDGE_CALLS, in
// run-llm-judge.ts) remains the true provider ceiling.
export const EVAL_SWEEP_INTERVAL_MS = config.EVAL_SWEEP_INTERVAL_MS;
const MAX_PER_SWEEP = config.EVAL_MAX_PER_SWEEP; // bound the work per tick so one sweep can't run unbounded
// Sessions judged concurrently within one sweep. The judge-call semaphore
// (MAX_CONCURRENT_JUDGE_CALLS) still caps total provider concurrency, so this
// only overlaps sessions' wall-clock — it can't stack provider load.
const MAX_CONCURRENT_SESSIONS = config.EVAL_MAX_CONCURRENT_SESSIONS;
// Re-assert claim ownership at least this often while judging, so a healthy
// long-running judge is never stale-adopted (heartbeat interval << stale window).
const CLAIM_HEARTBEAT_MS = 60_000;

let handle: SweeperHandle | null = null;
let sweeping = false;

/** Fan the stored verdicts out as per-judge rows in ao_session_external_evals so
 *  the existing conversation-evals surfaces (agent tab, session drawer, alert
 *  count rules) render sweeper results with zero extra read paths. Runs BEFORE
 *  completeSessionEvalVerdicts (a fan-out crash after 'done' — terminal, no
 *  retry — would strand the only rows those surfaces read). Idempotent on
 *  IDENTITY: it clears this session's prior eval_sweeper rows and rewrites the
 *  current set in one transaction, so a retry re-judge (which yields fresh
 *  reasoning text) can't leave duplicate rows for alert count-rules to
 *  double-weight. Row shape mirrors the OTLP "evaluation" records: verdict
 *  pass/fail + reasoning, `tag` = the node's opaque ref so consumers group by node. */
export async function fanOutExternalEvals(
  sessionId: string,
  verdicts: SessionEvalVerdicts,
  /** Call-end time. Rows are stamped with CALL time, not judge time — a
   *  backlog flush of old sessions must not inject its fails into the
   *  CURRENT alert window. */
  observedAt: Date = new Date(),
): Promise<void> {
  const rows = buildExternalEvalRows(verdicts);

  // Idempotent on IDENTITY, not payload. A retry re-judge produces fresh
  // reasoning text (new `raw`), so a payload-keyed dedup would let the retry's
  // rows sit alongside the first run's and alert count-rules would double-weight
  // the session. Instead, clear this session's prior eval_sweeper rows and write
  // the current set in ONE transaction: a crash rolls the whole set back (never
  // a partial fan-out), and a retry (or a stale-adoption re-judge) re-fans cleanly.
  await sql.begin(async (tx: typeof sql) => {
    await tx`DELETE FROM ao_session_external_evals WHERE session_id = ${sessionId} AND source = 'eval_sweeper'`;
    for (const row of rows) {
      await insertLiveKitEvaluation({
        sessionId,
        source: "eval_sweeper",
        judgeName: row.judgeName,
        tag: row.tag,
        verdict: row.passed ? "pass" : "fail",
        reasoning: row.reasoning || null,
        instructions: null,
        observedAt,
        raw: row.raw,
      }, tx);
    }
  });
}

/** True when the error would fail identically on retry (schema/content
 *  policy). Transient provider trouble (timeouts, 429s, 5xx, network) must
 *  NOT terminally poison a session — leaving the claim `running` lets the
 *  stale-claim adoption re-judge it after EVAL_CLAIM_STALE_MINUTES. */
function isTerminalEvalError(e: unknown): boolean {
  const seen = new Set<unknown>();
  let messages = "";
  for (let cur = e; cur && typeof cur === "object" && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur);
    messages += ` ${(cur as Error).message ?? ""}`;
  }
  // Auth failures (401/403/expired or rotated key) are environmental, not
  // input-determined — once the key is fixed the same session judges fine.
  // Treating them as terminal would permanently poison every session claimed
  // during a key-rotation gap.
  // Status codes are word-boundary anchored: bare `50[0-9]` would match the
  // "500" inside token counts like "1500" in judge error messages and
  // misclassify a deterministic failure as transient (endless re-judging).
  if (/timeout|timed.?out|\b429\b|rate.?limit|too many requests|\b50[0-9]\b|overloaded|unavailable|unable to connect|connection (refused|reset|closed|error)|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|fetch failed|\b40[13]\b|unauthoriz|forbidden|invalid.?api.?key|authentication|permission denied/i.test(messages)) {
    return false;
  }
  return true;
}

/** Synthesize builder events from stored chat_history items when the OTLP
 *  event channel was lost — judging the recording's transcript beats marking
 *  a fully transcribed call "done" with phantom empty-input verdicts. */
function eventsFromChatHistory(chatHistory: unknown): StoredEvent[] {
  if (!Array.isArray(chatHistory)) return [];
  return chatHistory
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      // `node_ref` is the generic contract (mirrors the OTLP chat-item field);
      // `node_run_uuid` is kept as a legacy alias for senders whose recording
      // serializer predates the generic field name.
      const anyItem = item as any;
      const ref = typeof anyItem.node_ref === "string" && anyItem.node_ref
        ? anyItem.node_ref
        : (typeof anyItem.node_run_uuid === "string" && anyItem.node_run_uuid ? anyItem.node_run_uuid : "");
      return { type: "conversation_item_added", ...(ref ? { node_ref: ref } : {}), item };
    });
}

/** Judge one claimed session end-to-end. Returns false on a terminal failure. */
async function judgeClaimed(claim: EvalClaim): Promise<boolean> {
  const sessionId = claim.sessionId;
  // Poison isolation: a session whose stored JSON can't be read (e.g. the
  // 2026-07-13 bun-runtime jsonb corruption) must fail THAT session as a
  // terminal eval_error — an uncaught throw here killed every sweep tick and
  // stalled the whole backlog behind one bad row.
  let source: Awaited<ReturnType<typeof getSessionEvalSource>>;
  try {
    source = await getSessionEvalSource(sessionId);
  } catch (e) {
    await failSessionEvalVerdicts(claim, `unreadable session data: ${(e as Error).message}`);
    console.error(`[evals] eval_error session=${sanitizeForLog(sessionId)}: unreadable session data: ${(e as Error).message}`);
    return false;
  }
  if (!source) {
    // Config/session vanished between claim and read — release as error so it
    // isn't reclaimed forever.
    await failSessionEvalVerdicts(claim, "eval source not found");
    return false;
  }

  // Heartbeat: re-assert ownership well inside the stale window so a long
  // judge run (many nodes x slow provider) is never adopted mid-flight and
  // double-judged. Losing the heartbeat aborts the run before more spend.
  let ownershipLost = false;
  const heartbeat = setInterval(() => {
    void heartbeatEvalClaim(claim).then((token) => {
      if (token === null) {
        ownershipLost = true;
      } else {
        claim.token = token;
      }
    }).catch(() => { /* transient DB blip — next beat retries */ });
  }, CLAIM_HEARTBEAT_MS);
  if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();

  try {
    const rawReport = (source.rawReport ?? {}) as { events?: unknown };
    let events: StoredEvent[] = Array.isArray(rawReport.events) ? (rawReport.events as StoredEvent[]) : [];
    if (events.length === 0) {
      events = eventsFromChatHistory(source.chatHistory);
    }
    // Gate on JUDGEABLE content, not raw array length: an events array of
    // non-conversation entries (or empty-content items) builds zero turns,
    // and judging that would store the exact phantom all-pass verdicts this
    // guard exists to prevent.
    const built = buildSessionEvalInput(source.config as AgentConfig, events);
    if (built.input.nodes.length === 0 || !built.input.full_transcript.trim()) {
      // No judgeable transcript. A young session may simply have its chat
      // items still in flight (config can land in an earlier OTLP batch than
      // the items) — give it a grace window instead of stamping a premature
      // terminal error.
      const ageMs = source.sessionCreatedAt ? Date.now() - source.sessionCreatedAt.getTime() : Infinity;
      const NO_TRANSCRIPT_GRACE_MS = 10 * 60 * 1000;
      if (ageMs < NO_TRANSCRIPT_GRACE_MS) {
        // Backdate the claim so stale adoption re-picks it in ~2 minutes —
        // without this, "will retry" would silently mean the FULL stale
        // window (15 min), long after the in-flight transcript landed.
        await deferEvalClaimRetry(claim, 120);
        console.warn(`[evals] session=${sanitizeForLog(sessionId)} has no judgeable transcript yet (age ${Math.round(ageMs / 1000)}s) — retrying in ~2min`);
        return false;
      }
      await failSessionEvalVerdicts(claim, "no judgeable transcript to evaluate");
      return false;
    }

    const verdicts = await evaluateIngestedSession(source.config as AgentConfig, events, undefined, source.transport ?? undefined);
    if (ownershipLost) {
      // Another sweeper adopted the claim mid-judge — its results win; ours
      // are discarded so the session is never double-completed/fanned out.
      console.warn(`[evals] claim lost mid-judge session=${sanitizeForLog(sessionId)} — discarding this run`);
      return false;
    }
    // Fan out BEFORE marking the session done. fanOutExternalEvals is
    // idempotent on identity (it clears + rewrites this session's eval_sweeper
    // rows in one transaction), so a crash between here and completion just
    // re-judges and re-fans on retry — no duplicate rows.
    // Marking done first would strand these rows: 'done' is terminal and the
    // fan-out has no retry, so a fan-out crash after completion would lose the
    // only rows the evals tab, session drawer, and alert rules read.
    try {
      await fanOutExternalEvals(sessionId, verdicts, source.sessionEndedAt ?? new Date());
    } catch (e) {
      // Leave the claim running so the stale-adoption retry re-fans; don't
      // complete on top of a partial fan-out.
      console.error(`[evals] fan-out failed (will retry) session=${sanitizeForLog(sessionId)}: ${(e as Error).message}`);
      return false;
    }
    const completed = await completeSessionEvalVerdicts(claim, verdicts as unknown as Record<string, unknown>);
    if (!completed) {
      // Lost the claim at the final write (stale adoption / bulk delete). The
      // fan-out above is identity-idempotent, so the winner's re-fan clears +
      // rewrites our rows — nothing to undo; just don't double-complete.
      console.warn(`[evals] complete skipped (claim not ours anymore) session=${sanitizeForLog(sessionId)}`);
      return false;
    }
    const nodes = verdicts.node_evaluations.length;
    console.log(`[evals] judged session=${sanitizeForLog(sessionId)} nodes=${nodes}`);
    return true;
  } catch (e) {
    if (!isTerminalEvalError(e)) {
      // Transient (timeout/429/5xx/network): keep the claim `running` so the
      // stale-adoption path retries it instead of poisoning the session.
      // (claimNextEvalSession retires claims older than the retry budget, so
      // "retry via stale adoption" can no longer mean "retry forever".)
      console.warn(`[evals] transient eval failure session=${sanitizeForLog(sessionId)} (will retry): ${(e as Error).message}`);
      return false;
    }
    // Deterministic failure (schema/content policy) — the same input would
    // fail identically, so DLQ-style record it and move on.
    await failSessionEvalVerdicts(claim, (e as Error).message);
    console.error(`[evals] eval_error session=${sanitizeForLog(sessionId)}: ${(e as Error).message}`);
    return false;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runEvalSweepOnce(): Promise<void> {
  if (sweeping) return; // re-entrancy guard: a slow sweep can't stack
  sweeping = true;
  try {
    const pending = await countPendingEvalSessions();
    // Nothing claimable — stop here rather than spinning up the worker fan-out.
    //
    // This count draws on EXACTLY the two sources claimNextEvalSession draws
    // on (configs past the settle window with no verdict row, plus stale
    // 'running' claims), with the same predicates, so pending === 0 provably
    // means every claim attempt would return null.
    //
    // Without this guard the drained case — which is the steady state whenever
    // judging is keeping up — costs the most: all MAX_CONCURRENT_SESSIONS
    // workers race in, each running the claim anti-join up to 3 times before
    // concluding the same thing this count already established. At prod's
    // concurrency of 15 that is 45 anti-joins over ao_session_agent_config
    // every tick, forever, to discover there is no work. The scan is O(table),
    // so it got heavier as the tables grew and put the us-east core writer at
    // 85-92% CPU (the claim query alone measured ~6 average active sessions on
    // a 2-vCPU box).
    //
    // A session landing between this count and the next tick is not delayed by
    // it: the ingest event-kick claims those directly, and the poller is the
    // 20s backstop it already was.
    if (pending === 0) return;
    console.log(`[evals] backlog=${pending} pending sessions`);
    // N workers each loop claim->judge until the tick budget is spent or the
    // backlog drains. Concurrency overlaps sessions' wall-clock (provider
    // concurrency stays capped by the judge semaphore), so one slow session
    // can't serialize the whole tick.
    let remaining = MAX_PER_SWEEP;
    const worker = async (): Promise<void> => {
      while (remaining > 0) {
        remaining--;
        const claim = await claimNextEvalSession();
        if (!claim) return; // backlog drained
        await judgeClaimed(claim);
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT_SESSIONS }, () => worker()));
  } catch (e) {
    console.error(`[evals] sweep failed: ${(e as Error).message}`);
  } finally {
    sweeping = false;
  }
}

// Event-kick concurrency: bound how many sessions a burst of call-endings can
// judge at once from the ingest path. The judge-call semaphore
// (MAX_CONCURRENT_JUDGE_CALLS) still caps provider concurrency; this only
// bounds how many full-session judges the ingest hot path spawns before it
// defers the rest to the poller. Mirrors the sweep's MAX_CONCURRENT_SESSIONS.
const MAX_CONCURRENT_KICKS = config.EVAL_MAX_CONCURRENT_KICKS;
let activeKicks = 0;

/**
 * Push, not poll: judge ONE session the instant its ingest completes, instead
 * of waiting for the next 20s poll tick + settle window. Best-effort and fully
 * covered by the poller — a no-op here (kick disabled, sweeper not in this
 * process, burst backpressure, session not yet complete, or already claimed)
 * just means the poller judges it on its normal schedule.
 *
 * MUST NOT be awaited on the ingest hot path — call as `void
 * kickEvalForSession(id)` so a slow judge run never delays the ingest 200.
 */
export async function kickEvalForSession(sessionId: string): Promise<void> {
  if (config.EVAL_EVENT_KICK === "off") return;
  // Only the inline-sweeper process both ingests AND judges; in worker mode the
  // API ingests but the worker's poller judges, so an in-process kick here
  // would judge in the wrong process (or not at all). Poller covers it.
  if (config.EVAL_SWEEPER !== "inline") return;
  if (activeKicks >= MAX_CONCURRENT_KICKS) return; // burst backpressure → poller covers it
  activeKicks++;
  try {
    const claim = await claimEvalSessionNow(sessionId);
    if (!claim) return; // already claimed/judged, or data not fully landed → poller covers it
    await judgeClaimed(claim);
  } catch (e) {
    console.warn(`[evals] event-kick failed session=${sanitizeForLog(sessionId)} (poller will retry): ${(e as Error).message}`);
  } finally {
    activeKicks--;
  }
}

export function startEvalSweeper(): void {
  if (handle) return; // idempotent — never stack two timers
  handle = startSweeper(() => runEvalSweepOnce(), EVAL_SWEEP_INTERVAL_MS, "evals");
}

export function stopEvalSweeper(): void {
  handle?.stop();
  handle = null;
}
