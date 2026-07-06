import { insertLiveKitEvaluation } from "../db.js";
import {
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

export const EVAL_SWEEP_INTERVAL_MS = 20_000;
const MAX_PER_SWEEP = 20; // bound the work per tick so one sweep can't run unbounded
// Sessions judged concurrently within one sweep. The judge-call semaphore
// (MAX_CONCURRENT_JUDGE_CALLS) still caps total provider concurrency, so this
// only overlaps sessions' wall-clock — it can't stack provider load.
const MAX_CONCURRENT_SESSIONS = 3;
// Re-assert claim ownership at least this often while judging, so a healthy
// long-running judge is never stale-adopted (heartbeat interval << stale window).
const CLAIM_HEARTBEAT_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/** Fan the stored verdicts out as per-judge rows in session_external_evals so
 *  the existing conversation-evals surfaces (agent tab, session drawer, alert
 *  count rules) render sweeper results with zero extra read paths. Runs AFTER
 *  completeSessionEvalVerdicts — the claim row stays the source of truth; a
 *  crash between the two loses only the denormalized rows, never the verdicts,
 *  and can't double-judge (done is terminal). Row shape mirrors the OTLP
 *  "evaluation" records: verdict pass/fail + reasoning, `tag` = the node's
 *  opaque ref so consumers can group by node. */
export async function fanOutExternalEvals(
  sessionId: string,
  verdicts: SessionEvalVerdicts,
  /** Call-end time. Rows are stamped with CALL time, not judge time — a
   *  backlog flush of old sessions must not inject its fails into the
   *  CURRENT alert window. */
  observedAt: Date = new Date(),
): Promise<void> {
  const rows: Array<{ judgeName: string; tag: string | null; passed: boolean; reasoning: string; raw: Record<string, unknown> }> = [];

  for (const ne of verdicts.node_evaluations) {
    const tag = ne.ref || null;
    const ia = ne.instructions_adherence;
    if (ia) rows.push({ judgeName: "instructions_adherence", tag, passed: ia.adherence_passed, reasoning: ia.reason, raw: ia as any });
    const ii = ne.intent_identification;
    if (ii) rows.push({ judgeName: "intent_identification", tag, passed: !(ii.intent_not_found || ii.intent_wrongly_identified), reasoning: ii.reason, raw: ii as any });
    const ve = ne.variable_extraction;
    if (ve) rows.push({ judgeName: "variable_extraction", tag, passed: ve.extraction_successful, reasoning: ve.reason, raw: ve as any });
    const ha = ne.hallucination;
    if (ha) rows.push({ judgeName: "hallucination", tag, passed: !ha.hallucinated, reasoning: ha.reason, raw: ha as any });
    const lo = ne.node_loop;
    if (lo) rows.push({ judgeName: "node_loop", tag, passed: !lo.loop_detected, reasoning: lo.reason, raw: lo as any });
  }
  // Conversation-axis judges (whole-transcript, no node tag). Detections read
  // as fail when they fire; sentiment fails when clearly negative or confused
  // (matching the sentiment judge's own pass rule).
  // Judge-unavailable fallbacks (the judges fail open to detected:false with
  // technical_reason "…unavailable") are SKIPPED, not written as passes — a
  // provider outage must not silently bias fail rates to zero.
  const cm = verdicts.conversation_metrics;
  if (cm) {
    const detections: Array<[string, { detected: boolean; reason: string; technical_reason?: string; available?: boolean } | undefined]> = [
      ["voicemail_detection", cm.voicemail_detected],
      ["bot_detection", cm.bot_detected],
      ["call_screening", cm.call_screening],
      ["low_engagement", cm.low_engagement],
      ["wrong_number", cm.wrong_number],
      ["do_not_disturb", cm.do_not_disturb],
    ];
    for (const [judgeName, det] of detections) {
      if (!det || typeof det.detected !== "boolean") continue;
      // Skip a judge that didn't run: prefer the explicit `available` flag,
      // fall back to the legacy sentinel string only when it's absent.
      if (det.available === false || (det.available === undefined && /judge unavailable/i.test(det.technical_reason ?? ""))) continue;
      rows.push({ judgeName, tag: null, passed: !det.detected, reasoning: det.reason, raw: det as any });
    }
    const sentiment = cm.user_sentiment as { sentiment?: string; reason?: string; technical_reason?: string; available?: boolean; passed?: boolean } | undefined;
    const sentimentValue = sentiment?.sentiment ?? "";
    const sentimentUnavailable = sentiment?.available === false
      || (sentiment?.available === undefined && /judge unavailable/i.test(sentiment?.technical_reason ?? ""));
    if (sentimentValue && sentimentValue !== "unknown" && !sentimentUnavailable) {
      rows.push({
        judgeName: "user_sentiment",
        tag: null,
        // The verdict carries the derived pass/fail; only fall back to the
        // rule (via sentimentPassed) for payloads that predate the field.
        passed: sentiment?.passed ?? sentimentPassed(sentimentValue),
        reasoning: sentiment?.reason ? `${sentimentValue}: ${sentiment.reason}` : sentimentValue,
        raw: sentiment as any,
      });
    }
  }

  for (const goal of verdicts.goal_evaluation?.goals ?? []) {
    rows.push({
      judgeName: goal.goal_name ? `goal:${goal.goal_name}` : "goal",
      tag: null,
      passed: goal.achieved,
      reasoning: goal.reason,
      raw: goal as any,
    });
  }

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
    });
  }
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

    const verdicts = await evaluateIngestedSession(source.config as AgentConfig, events);
    if (ownershipLost) {
      // Another sweeper adopted the claim mid-judge — its results win; ours
      // are discarded so the session is never double-completed/fanned out.
      console.warn(`[evals] claim lost mid-judge session=${sanitizeForLog(sessionId)} — discarding this run`);
      return false;
    }
    // Fan out BEFORE marking the session done. insertLiveKitEvaluation is
    // idempotent (dedup on session/source/judge/tag/raw), so a crash between
    // here and completion just re-judges and re-fans on retry — no duplicates.
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
      // fan-out above was idempotent, so the winner's identical rows dedup
      // against ours — nothing to undo; just don't double-complete.
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
