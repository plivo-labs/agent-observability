/**
 * Db layer for the conversation-goal analyzer. Eligibility is derived,
 * not stored: a session is a candidate when it has ≥1 goal:<text> tag
 * (from EITHER ingest path), a spoken transcript (transcript_text from
 * migration 018 is non-null exactly when message content exists), and no
 * blocking row in session_goal_analyses (migration 019).
 *
 * bun:sql gotchas apply (see src/alerts/engine.ts header): never use the
 * jsonb `?` operator in query text, and pass JS objects raw for ::jsonb
 * params.
 */
import { sql, insertLiveKitEvaluation } from "../db.js";
import { parseGoalTags } from "./extract.js";

const STALE_CLAIM = "10 minutes";
export const MAX_ATTEMPTS = 3;

export interface GoalVerdictInput {
  goal: string;
  met: boolean;
  reasoning: string;
  whatWentWrong: string | null;
}

/**
 * Find eligible sessions and atomically claim up to `limit` of them.
 * Returns the claimed session ids. Safe to call concurrently from the
 * API-inline analyzer and the worker: the ON CONFLICT claim only
 * succeeds for new, retryable-error, or stale-claimed rows.
 */
export async function claimGoalSessions(limit: number): Promise<string[]> {
  const candidates = await sql.unsafe(
    `SELECT s.session_id
     FROM agent_transport_sessions s
     WHERE s.transcript_text IS NOT NULL
       AND (
         EXISTS (
           SELECT 1 FROM session_tags st
           WHERE st.session_id = s.session_id AND st.name LIKE 'goal:%'
         )
         OR (
           jsonb_typeof(s.raw_report->'tags') = 'array'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(s.raw_report->'tags') tag(v)
             WHERE tag.v LIKE 'goal:%'
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM session_goal_analyses g
         WHERE g.session_id = s.session_id
           AND (
             g.status = 'done'
             OR g.attempts >= ${MAX_ATTEMPTS}
             OR (g.status = 'claimed' AND g.claimed_at > NOW() - interval '${STALE_CLAIM}')
           )
       )
     ORDER BY s.ended_at DESC
     LIMIT $1`,
    [limit],
  );

  const claimed: string[] = [];
  for (const row of candidates) {
    const got = await sql.unsafe(
      `INSERT INTO session_goal_analyses (session_id, status, claimed_at)
       VALUES ($1, 'claimed', NOW())
       ON CONFLICT (session_id) DO UPDATE
       SET status = 'claimed', claimed_at = NOW()
       WHERE (session_goal_analyses.status = 'error' AND session_goal_analyses.attempts < ${MAX_ATTEMPTS})
          OR (session_goal_analyses.status = 'claimed'
              AND session_goal_analyses.claimed_at < NOW() - interval '${STALE_CLAIM}')
       RETURNING session_id`,
      [row.session_id],
    );
    if (got.length > 0) claimed.push(got[0].session_id);
    if (claimed.length >= limit) break;
  }
  return claimed;
}

/** Goals (merged from both tag sources, parsed) + the raw chat history. */
export async function loadGoalSession(
  sessionId: string,
): Promise<{ goals: string[]; chatHistory: unknown }> {
  const [row] = await sql`
    SELECT chat_history, raw_report->'tags' AS rr_tags
    FROM agent_transport_sessions
    WHERE session_id = ${sessionId}
    LIMIT 1
  `;
  const tagRows = await sql`
    SELECT name FROM session_tags
    WHERE session_id = ${sessionId} AND name LIKE 'goal:%'
    ORDER BY id
  `;
  const rrTags: unknown[] = Array.isArray(row?.rr_tags) ? row.rr_tags : [];
  const goals = parseGoalTags([...tagRows.map((r: { name: string }) => r.name), ...rrTags]);
  return { goals, chatHistory: row?.chat_history ?? null };
}

/** Write one verdict row per goal and mark the session done — one
 *  transaction, so verdicts can't exist while the session looks pending
 *  (and vice versa). */
export async function completeGoalAnalysis(
  sessionId: string,
  verdicts: GoalVerdictInput[],
): Promise<void> {
  const observedAt = new Date();
  await sql.begin(async (tx) => {
    for (const v of verdicts) {
      await insertLiveKitEvaluation(
        {
          sessionId,
          source: "goal",
          judgeName: "goal",
          tag: null,
          verdict: v.met ? "met" : "unmet",
          reasoning: v.reasoning,
          instructions: v.goal,
          observedAt,
          raw: {
            goal: v.goal,
            met: v.met,
            reasoning: v.reasoning,
            what_went_wrong: v.whatWentWrong,
          },
        },
        tx,
      );
    }
    await tx`
      UPDATE session_goal_analyses
      SET status = 'done', analyzed_at = NOW(), last_error = NULL
      WHERE session_id = ${sessionId}
    `;
  });
}

export async function markGoalAnalysisError(sessionId: string, message: string): Promise<void> {
  await sql`
    UPDATE session_goal_analyses
    SET status = 'error', attempts = attempts + 1, last_error = ${message}
    WHERE session_id = ${sessionId}
  `;
}
