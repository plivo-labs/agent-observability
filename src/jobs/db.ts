import { sql } from "../db.js";

export interface Job<T = unknown> {
  id: string;
  type: string;
  payload: T;
  status: "pending" | "done" | "dead";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

// bun:sql returns JSONB as a parsed value, but some driver versions hand back
// a raw string — normalize both (same guard as src/alerts/db.ts; duplicated
// rather than shared to keep the alerts module untouched).
function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function mapJob(r: any): Job {
  return {
    id: r.id,
    type: r.type,
    payload: parseJsonb<unknown>(r.payload, {}),
    status: r.status,
    attempts: r.attempts,
    max_attempts: r.max_attempts,
    next_attempt_at: r.next_attempt_at,
    last_error: r.last_error ?? null,
  };
}

/**
 * Enqueue a job. When `idempotencyKey` is supplied, a redelivered request with
 * the same key is a no-op (ON CONFLICT DO NOTHING) — safe webhook redelivery.
 * Returns the new job id, or null when an existing key suppressed the insert.
 *
 * Due-time is anchored to the DB clock (`NOW()`) for immediate jobs, never the
 * client clock — claimability compares `next_attempt_at <= NOW()`, so stamping
 * a client `Date` makes a job briefly unclaimable under any client/DB skew.
 * An explicit `runAfter` (intentional future scheduling) is honored as given.
 */
export async function enqueueJob(
  type: string,
  payload: unknown,
  opts: { idempotencyKey?: string; runAfter?: Date; maxAttempts?: number } = {},
): Promise<string | null> {
  const rows = await sql`
    INSERT INTO jobs (type, payload, idempotency_key, next_attempt_at, max_attempts)
    VALUES (
      ${type},
      ${payload}::jsonb,
      ${opts.idempotencyKey ?? null},
      COALESCE(${opts.runAfter ?? null}::timestamptz, NOW()),
      ${opts.maxAttempts ?? 6}
    )
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

/** How long a claimed job is leased before it becomes due again (crash safety). */
const CLAIM_LEASE = "2 minutes";

/**
 * Atomically claim up to `limit` due jobs. attempts is incremented here (not at
 * completion) so a job that crashes the worker still counts against
 * max_attempts and can't be reclaimed forever (poison-job protection). Two
 * workers never claim the same job (FOR UPDATE SKIP LOCKED).
 */
export async function claimJobs(limit = 20): Promise<Job[]> {
  const rows = await sql`
    WITH due AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs j
    SET next_attempt_at = NOW() + ${CLAIM_LEASE}::interval,
        attempts = j.attempts + 1,
        locked_at = NOW(),
        updated_at = NOW()
    FROM due
    WHERE j.id = due.id
    RETURNING j.*
  `;
  return rows.map(mapJob);
}

export async function completeJob(id: string): Promise<void> {
  await sql`
    UPDATE jobs SET status = 'done', last_error = NULL, locked_at = NULL, updated_at = NOW()
    WHERE id = ${id}
  `;
}

/** Reschedule a failed job for another attempt at `nextAttemptAt`. */
export async function retryJob(id: string, nextAttemptAt: Date, error: string): Promise<void> {
  await sql`
    UPDATE jobs SET
      status = 'pending', next_attempt_at = ${nextAttemptAt},
      last_error = ${error}, locked_at = NULL, updated_at = NOW()
    WHERE id = ${id}
  `;
}

/** Terminal failure — no more attempts. */
export async function deadJob(id: string, error: string): Promise<void> {
  await sql`
    UPDATE jobs SET status = 'dead', last_error = ${error}, locked_at = NULL, updated_at = NOW()
    WHERE id = ${id}
  `;
}
