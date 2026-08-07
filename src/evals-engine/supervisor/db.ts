// Supervisor layer — claim + persistence + read aggregates.
//
// Reuses the verdicts table for claim state (review_status/review_claimed_at):
// claims a done-but-unreviewed verdict, re-adopts stale review claims. Reviews
// land in ao_session_eval_reviews (idempotent per session+axis+node).

import { sql } from "../../db.js";
import type { AxisReview } from "./reviewer.js";

const REVIEW_STALE_MINUTES = 15;

export interface ReviewClaim {
  sessionId: string;
  verdicts: Record<string, unknown>;
  observedAt: Date | null;
}

/** Claim the next done-but-unreviewed verdict (or re-adopt a stale review claim). */
export async function claimNextReview(): Promise<ReviewClaim | null> {
  const rows = await sql`
    UPDATE ao_session_eval_verdicts
    SET review_status = 'running', review_claimed_at = NOW(), updated_at = NOW()
    WHERE session_id = (
      SELECT session_id FROM ao_session_eval_verdicts
      WHERE status = 'done'
        AND (review_status IS NULL
             OR (review_status = 'running' AND review_claimed_at < NOW() - INTERVAL '1 minute' * ${REVIEW_STALE_MINUTES}))
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING session_id, verdicts, completed_at
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  const verdicts = typeof r.verdicts === "string" ? JSON.parse(r.verdicts) : r.verdicts;
  return {
    sessionId: r.session_id as string,
    verdicts: (verdicts ?? {}) as Record<string, unknown>,
    observedAt: r.completed_at ? new Date(r.completed_at) : null,
  };
}

export async function markReviewDone(sessionId: string): Promise<void> {
  await sql`
    UPDATE ao_session_eval_verdicts
    SET review_status = 'done', reviewed_at = NOW(), review_error = NULL, updated_at = NOW()
    WHERE session_id = ${sessionId}
  `;
}

export async function markReviewError(sessionId: string, error: string): Promise<void> {
  await sql`
    UPDATE ao_session_eval_verdicts
    SET review_status = 'error', review_error = ${error.slice(0, 2000)}, reviewed_at = NOW(), updated_at = NOW()
    WHERE session_id = ${sessionId}
  `;
}

/** Idempotent upsert of one axis review (re-review overwrites in place). */
export async function storeReview(sessionId: string, r: AxisReview, observedAt: Date | null): Promise<void> {
  await sql`
    INSERT INTO ao_session_eval_reviews (
      session_id, axis, node_ref, node_name, original_verdict, original_reason,
      supervisor_verdict, supervisor_reason, agreement, votes_for, votes_total,
      suggested_fix, supervisor_model, observed_at
    ) VALUES (
      ${sessionId}, ${r.axis}, ${r.nodeRef}, ${r.nodeName || null}, ${r.originalVerdict}, ${r.originalReason || null},
      ${r.supervisorVerdict}, ${r.supervisorReason || null}, ${r.agreement}, ${r.votesFor}, ${r.votesTotal},
      ${r.suggestedFix as unknown}, ${r.model || null}, ${observedAt}
    )
    ON CONFLICT (session_id, axis, node_ref) DO UPDATE SET
      original_verdict = EXCLUDED.original_verdict, original_reason = EXCLUDED.original_reason,
      supervisor_verdict = EXCLUDED.supervisor_verdict, supervisor_reason = EXCLUDED.supervisor_reason,
      agreement = EXCLUDED.agreement, votes_for = EXCLUDED.votes_for, votes_total = EXCLUDED.votes_total,
      suggested_fix = EXCLUDED.suggested_fix, supervisor_model = EXCLUDED.supervisor_model,
      observed_at = EXCLUDED.observed_at, updated_at = NOW()
  `;
}

/** Tab top level: misflags grouped by judge axis. */
export async function misflagsByAxis(): Promise<Array<{ axis: string; misflags: number; reviewed: number; last_at: string | null }>> {
  const rows = await sql`
    SELECT axis,
           COUNT(*) FILTER (WHERE agreement = false)::int AS misflags,
           COUNT(*)::int AS reviewed,
           MAX(created_at) FILTER (WHERE agreement = false) AS last_at
    FROM ao_session_eval_reviews
    GROUP BY axis
    ORDER BY misflags DESC, reviewed DESC
  `;
  return rows as Array<{ axis: string; misflags: number; reviewed: number; last_at: string | null }>;
}

/** Drill-down: the misflagged cases for one axis + their suggested fixes. */
export async function misflagsForAxis(axis: string, limit = 100): Promise<unknown[]> {
  const rows = await sql`
    SELECT session_id, axis, node_ref, node_name, original_verdict, original_reason,
           supervisor_verdict, supervisor_reason, votes_for, votes_total,
           suggested_fix, supervisor_model, observed_at, created_at
    FROM ao_session_eval_reviews
    WHERE axis = ${axis} AND agreement = false
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
  return rows;
}

/** Count of verdicts still awaiting review (queue depth for the sweep log). */
export async function pendingReviews(): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM ao_session_eval_verdicts
    WHERE status = 'done' AND review_status IS NULL
  `;
  return Number(rows[0]?.n ?? 0);
}
