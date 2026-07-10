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
import { classifyErrorDurability } from "../error-durability.js";
import { sanitizeForLog } from "../response.js";
import { startSweeper, type SweeperHandle } from "../sweeper-loop.js";
import { buildSessionEvalInput, evaluateIngestedSession, type AgentConfig, type SessionEvalVerdicts, type StoredEvent } from "./integration/session-evals.js";
import { sentimentPassed } from "./judges/conversation-judges.js";

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
// `?? <default>` on each mirrors the schema defaults: prod config always carries
// them, so these only guard a partial/mocked config from producing undefined loops.
export const EVAL_SWEEP_INTERVAL_MS = config.EVAL_SWEEP_INTERVAL_MS ?? 20_000;
const MAX_PER_SWEEP = config.EVAL_MAX_PER_SWEEP ?? 20; // bound the work per tick so one sweep can't run unbounded
// Sessions judged concurrently within one sweep. The judge-call semaphore
// (MAX_CONCURRENT_JUDGE_CALLS) still caps total provider concurrency, so this
// only overlaps sessions' wall-clock — it can't stack provider load.
const MAX_CONCURRENT_SESSIONS = config.EVAL_MAX_CONCURRENT_SESSIONS ?? 3;
// Re-assert claim ownership at least this often while judging, so a healthy
// long-running judge is never stale-adopted (heartbeat interval << stale window).
const CLAIM_HEARTBEAT_MS = 60_000;

let handle: SweeperHandle | null = null;
let sweeping = false;

// Boot-time table probe, shared by every eval entry point (inline sweeper,
// worker sweeper, ingest event-kick). A deploy whose DB lacks the eval tables
// (sim-only/OSS, or prod before the core-db eval migration lands) must go
// quiet with ONE log line — not error-log `relation "ao_session_agent_config"
// does not exist` every sweep tick plus one warn per ingest kick.
// `null` = never probed (tests import kickEvalForSession directly with a
// mocked db) — treated as present so mocked suites keep exercising the kick.
let evalTablesPresent: boolean | null = null;

/** Probe once at boot; callers gate startEvalSweeper() on the result. The
 *  outcome also disarms kickEvalForSession, which shares the same tables. */
export async function probeEvalTables(): Promise<boolean> {
  const [row] = await sql`SELECT to_regclass('ao_session_eval_verdicts') IS NOT NULL AS present`;
  evalTablesPresent = row.present === true;
  return evalTablesPresent;
}

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
  const rows: Array<{ judgeName: string; tag: string | null; passed: boolean; reasoning: string; raw: object }> = [];

  for (const ne of verdicts.node_evaluations) {
    const tag = ne.ref || null;
    const ia = ne.instructions_adherence;
    if (ia) rows.push({ judgeName: "instructions_adherence", tag, passed: ia.adherence_passed, reasoning: ia.reason, raw: ia });
    const ii = ne.intent_identification;
    if (ii) rows.push({ judgeName: "intent_identification", tag, passed: !(ii.intent_not_found || ii.intent_wrongly_identified), reasoning: ii.reason, raw: ii });
    const ve = ne.variable_extraction;
    if (ve) rows.push({ judgeName: "variable_extraction", tag, passed: ve.extraction_successful, reasoning: ve.reason, raw: ve });
    const ha = ne.hallucination;
    if (ha) rows.push({ judgeName: "hallucination", tag, passed: !ha.hallucinated, reasoning: ha.reason, raw: ha });
    const lo = ne.node_loop;
    if (lo) rows.push({ judgeName: "node_loop", tag, passed: !lo.loop_detected, reasoning: lo.reason, raw: lo });
  }
  // Conversation-axis judges (whole-transcript, no node tag). Detections read
  // as fail when they fire; sentiment fails when clearly negative or confused
  // (matching the sentiment judge's own pass rule).
  // Judge-unavailable fallbacks (the judges fail open to detected:false with
  // technical_reason "…unavailable") are SKIPPED, not written as passes — a
  // provider outage must not silently bias fail rates to zero.
  const cm = verdicts.conversation_metrics;
  if (cm) {
    const detections: Array<[string, { detected: boolean; reason: string; available: boolean } | undefined]> = [
      ["voicemail_detection", cm.voicemail_detected],
      ["bot_detection", cm.bot_detected],
      ["call_screening", cm.call_screening],
      ["low_engagement", cm.low_engagement],
      ["wrong_number", cm.wrong_number],
      ["do_not_disturb", cm.do_not_disturb],
    ];
    for (const [judgeName, det] of detections) {
      if (!det || typeof det.detected !== "boolean") continue;
      // Skip a judge that couldn't run (provider outage) — never fan an
      // unavailable detection out as a `pass`. `available` is always set on
      // this path (real judges and the zero placeholder both set it).
      if (det.available === false) continue;
      rows.push({ judgeName, tag: null, passed: !det.detected, reasoning: det.reason, raw: det });
    }
    const sentiment = cm.user_sentiment;
    const sentimentValue = sentiment?.sentiment ?? "";
    if (sentimentValue && sentimentValue !== "unknown" && sentiment?.available !== false) {
      rows.push({
        judgeName: "user_sentiment",
        tag: null,
        // The verdict carries the derived pass/fail; only fall back to the
        // rule (via sentimentPassed) for payloads that predate the field.
        passed: sentiment?.passed ?? sentimentPassed(sentimentValue),
        reasoning: sentiment?.reason ? `${sentimentValue}: ${sentiment.reason}` : sentimentValue,
        raw: sentiment,
      });
    }
  }

  for (const goal of verdicts.goal_evaluation?.goals ?? []) {
    rows.push({
      judgeName: goal.goal_name ? `goal:${goal.goal_name}` : "goal",
      tag: null,
      passed: goal.achieved,
      reasoning: goal.reason,
      raw: goal,
    });
  }

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
 *  stale-claim adoption re-judge it after EVAL_CLAIM_STALE_MINUTES.
 *  Classification lives in error-durability.ts (shared with the OTLP persist
 *  path); only the DEFAULT is this site's: unknown → terminal, because a
 *  retry re-spends LLM budget and so needs positive environmental evidence. */
function isTerminalEvalError(e: unknown): boolean {
  return classifyErrorDurability(e) !== "transient";
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
  const source = await getSessionEvalSource(sessionId);
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
    const completed = await completeSessionEvalVerdicts(claim, verdicts);
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
    if (pending > 0) {
      console.log(`[evals] backlog=${pending} pending sessions`);
    }
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
const MAX_CONCURRENT_KICKS = config.EVAL_MAX_CONCURRENT_KICKS ?? 3;
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
  if (evalTablesPresent === false) return; // boot probe found no eval tables — nothing to judge into
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
