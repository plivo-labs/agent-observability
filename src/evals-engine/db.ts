// Ingest-eval claim lifecycle — the sweeper's work-claim + verdict state.
//
// Lives in its own feature module (repo convention: alerts/db.ts, evals/db.ts,
// …) since it is consumed only by the eval sweeper. The agent-config INGEST
// write (upsertSessionAgentConfig) stays in the shared db.ts with the other
// ingest writers.
//
// NOTE on the repeated predicates below (claim-eligibility + the
// status='running' AND claimed_at::text=<token> ownership guard): bun:sql
// tagged templates cannot compose a PARAMETERIZED fragment across separate
// statements without sql.unsafe, which the repo's bun:sql guidance cautions
// against. They are kept inline and adjacent here so the one file is the
// single place they are maintained.
import { sql } from "../db.js";

/** Grace period before a session becomes claimable — lets the multipart
 *  recording report land after the OTLP records so the transcript is
 *  complete when the judges read it. */
const EVAL_CLAIM_SETTLE_SECONDS = 30;
const EVAL_CLAIM_STALE_MINUTES = 15;

/**
 * Claim the next session that needs judging. Two-step: first adopt a stale
 * 'running' claim (a worker died mid-judge), otherwise claim a fresh session
 * that has an agent config + a stored session row and no verdicts yet. The
 * INSERT … ON CONFLICT DO NOTHING makes concurrent sweepers race-safe: exactly
 * one claims any given session. Returns the claimed session_id or null.
 */
/** Retry budget: a claim row's created_at is its FIRST claim time (never
 *  updated), so claims that keep failing transiently stop being re-adopted
 *  after this many hours and are marked as terminal errors instead —
 *  otherwise a persistently-failing session re-judges every stale window
 *  forever, burning provider spend with no way out. */
const EVAL_CLAIM_MAX_AGE_HOURS = 24;

/** A held claim: sessionId + fencing token. The token is the claim row's
 *  claimed_at rendered as text; every mutating call re-asserts it so a
 *  sweeper that lost its claim to stale adoption can never complete, fail,
 *  or fan out over the new owner's work. */
export interface EvalClaim {
  sessionId: string;
  token: string;
}

export async function claimNextEvalSession(): Promise<EvalClaim | null> {
  // Retire claims that exhausted their retry budget before adopting anything.
  await sql`
    UPDATE session_eval_verdicts
    SET status = 'error', error = 'retry budget exhausted (claim older than ${EVAL_CLAIM_MAX_AGE_HOURS}h)',
        completed_at = NOW(), updated_at = NOW()
    WHERE status = 'running'
      AND created_at < NOW() - INTERVAL '1 hour' * ${EVAL_CLAIM_MAX_AGE_HOURS}
      AND claimed_at < NOW() - INTERVAL '1 minute' * ${EVAL_CLAIM_STALE_MINUTES}
  `;

  const stale = await sql`
    UPDATE session_eval_verdicts SET claimed_at = NOW(), updated_at = NOW()
    WHERE session_id = (
      SELECT session_id FROM session_eval_verdicts
      WHERE status = 'running'
        AND claimed_at < NOW() - INTERVAL '1 minute' * ${EVAL_CLAIM_STALE_MINUTES}
      ORDER BY claimed_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING session_id, claimed_at::text AS token
  `;
  if (stale.length > 0) {
    return { sessionId: stale[0].session_id as string, token: stale[0].token as string };
  }

  // Fresh claims drain NEWEST first: the sessions a user is actively watching
  // (the console polls for a few minutes after call end) get judged before
  // backlog history, so verdicts appear while someone is still looking.
  // Up to 3 attempts: losing the INSERT race to a concurrent sweeper returns
  // 0 rows even though other candidates remain — re-running re-evaluates
  // NOT EXISTS (the winner's row now exists) and picks the next candidate,
  // so a race loss is never misread as "backlog drained".
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await sql`
      INSERT INTO session_eval_verdicts (session_id)
      SELECT c.session_id
      FROM session_agent_config c
      JOIN agent_transport_sessions s ON s.session_id = c.session_id
      WHERE NOT EXISTS (
          SELECT 1 FROM session_eval_verdicts v WHERE v.session_id = c.session_id
        )
        AND c.created_at < NOW() - INTERVAL '1 second' * ${EVAL_CLAIM_SETTLE_SECONDS}
      ORDER BY c.created_at DESC
      LIMIT 1
      ON CONFLICT (session_id) DO NOTHING
      RETURNING session_id, claimed_at::text AS token
    `;
    if (fresh.length > 0) {
      return { sessionId: fresh[0].session_id as string, token: fresh[0].token as string };
    }
    // 0 rows: either drained or a lost race — only a retry can tell.
  }
  return null;
}

/** Re-assert ownership mid-judge (call between judge phases). Returns the
 *  refreshed token, or null when the claim was adopted by another sweeper —
 *  the caller must abort instead of wasting further judge calls. */
export async function heartbeatEvalClaim(claim: EvalClaim): Promise<string | null> {
  const rows = await sql`
    UPDATE session_eval_verdicts
    SET claimed_at = NOW(), updated_at = NOW()
    WHERE session_id = ${claim.sessionId}
      AND status = 'running'
      AND claimed_at::text = ${claim.token}
    RETURNING claimed_at::text AS token
  `;
  return rows.length > 0 ? (rows[0].token as string) : null;
}

/** Returns false when ownership was lost (stale adoption or bulk delete) —
 *  the caller must then skip fan-out so it never writes rows for a session
 *  it no longer owns (or that no longer exists). */
export async function completeSessionEvalVerdicts(
  claim: EvalClaim,
  verdicts: Record<string, unknown>,
): Promise<boolean> {
  const rows = await sql`
    UPDATE session_eval_verdicts
    SET status = 'done', verdicts = ${verdicts}::jsonb, error = NULL,
        completed_at = NOW(), updated_at = NOW()
    WHERE session_id = ${claim.sessionId}
      AND status = 'running'
      AND claimed_at::text = ${claim.token}
    RETURNING session_id
  `;
  return rows.length > 0;
}

/** Terminal failure — deliberately not retried (deterministic errors like a
 *  provider content-policy rejection would fail identically every time). */
export async function failSessionEvalVerdicts(claim: EvalClaim, error: string): Promise<boolean> {
  const rows = await sql`
    UPDATE session_eval_verdicts
    SET status = 'error', error = ${error.slice(0, 2000)},
        completed_at = NOW(), updated_at = NOW()
    WHERE session_id = ${claim.sessionId}
      AND status = 'running'
      AND claimed_at::text = ${claim.token}
    RETURNING session_id
  `;
  return rows.length > 0;
}

/** Backlog depth: eligible sessions not yet claimed + stale re-adoptable
 *  claims. Logged each sweep so operators can see the queue growing before
 *  verdict latency does. */
export async function countPendingEvalSessions(): Promise<number> {
  const rows = await sql`
    SELECT
      (SELECT COUNT(*) FROM session_agent_config c
        JOIN agent_transport_sessions s ON s.session_id = c.session_id
        WHERE NOT EXISTS (SELECT 1 FROM session_eval_verdicts v WHERE v.session_id = c.session_id)
          AND c.created_at < NOW() - INTERVAL '1 second' * ${EVAL_CLAIM_SETTLE_SECONDS})
      +
      (SELECT COUNT(*) FROM session_eval_verdicts
        WHERE status = 'running'
          AND claimed_at < NOW() - INTERVAL '1 minute' * ${EVAL_CLAIM_STALE_MINUTES}) AS pending
  `;
  return Number(rows[0]?.pending ?? 0);
}

export interface SessionEvalSource {
  sessionId: string;
  config: Record<string, unknown>;
  chatHistory: unknown;
  rawReport: unknown;
  /** When the session row was ingested — lets the sweeper give a young
   *  session whose transcript hasn't fully landed a grace period instead of
   *  a terminal "no transcript" error. */
  sessionCreatedAt: Date | null;
  /** When the call actually ended — fan-out rows are stamped with this (not
   *  judge time) so windowed alert rules see call recency, and a backlog
   *  flush of old sessions can't page the CURRENT alert window. */
  sessionEndedAt: Date | null;
}

/** Backdate a running claim so stale adoption re-picks it after roughly
 *  `retryInSeconds` instead of the full stale window. Used when a claimed
 *  session isn't judgeable YET (transcript still in flight) — without this,
 *  a "will retry" defer would silently wait the whole EVAL_CLAIM_STALE_MINUTES. */
export async function deferEvalClaimRetry(claim: EvalClaim, retryInSeconds: number): Promise<void> {
  await sql`
    UPDATE session_eval_verdicts
    SET claimed_at = NOW() - (${EVAL_CLAIM_STALE_MINUTES} * INTERVAL '1 minute') + (${retryInSeconds} * INTERVAL '1 second')
    WHERE session_id = ${claim.sessionId} AND status = 'running'
      AND claimed_at::text = ${claim.token}
  `;
}

/** Everything the eval sweeper needs to judge one session. */
export async function getSessionEvalSource(sessionId: string): Promise<SessionEvalSource | null> {
  const rows = await sql`
    SELECT c.config, s.chat_history, s.raw_report, s.created_at AS session_created_at, s.ended_at AS session_ended_at
    FROM session_agent_config c
    JOIN agent_transport_sessions s ON s.session_id = c.session_id
    WHERE c.session_id = ${sessionId}
  `;
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    sessionId,
    config: parse(row.config) as Record<string, unknown>,
    chatHistory: parse(row.chat_history),
    rawReport: parse(row.raw_report),
    sessionCreatedAt: row.session_created_at ? new Date(row.session_created_at) : null,
    sessionEndedAt: row.session_ended_at ? new Date(row.session_ended_at) : null,
  };
}
