import { type Job, claimJobs, completeJob, retryJob, deadJob } from "./db.js";

// ── Generic job worker ──────────────────────────────────────────────────────
//
// Time-driven loop mirroring the alert sweeper: every JOB_SWEEP_INTERVAL_MS,
// claim due jobs and dispatch each to its registered handler. State lives in
// Postgres (claim lease + backoff), so retries survive restarts and two
// workers never run the same job. The dedicated worker entrypoint
// (src/worker.ts) calls runJobsOnce() directly in its loop; the API can also
// run it inline (JOBS_WORKER=inline) via startJobWorker().

export const JOB_SWEEP_INTERVAL_MS = 5_000;
export const JOB_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];

export type JobHandler<T = any> = (job: Job<T>) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Register the handler for a job type. Call once at startup, per type. */
export function registerJobHandler<T = any>(type: string, handler: JobHandler<T>): void {
  handlers.set(type, handler as JobHandler);
}

/** Test helper — drop all registered handlers. */
export function clearJobHandlers(): void {
  handlers.clear();
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * Claim a batch and process each job. attempts was already incremented at claim
 * time, so the retry-vs-dead decision compares the (post-claim) attempt count
 * against max_attempts. A job with no registered handler is treated as a
 * failure (retried, then dead) rather than silently dropped.
 */
export async function runJobsOnce(limit = 20): Promise<void> {
  if (sweeping) return; // re-entrancy guard: a slow batch can't stack
  sweeping = true;
  try {
    const jobs = await claimJobs(limit);
    for (const job of jobs) {
      const handler = handlers.get(job.type);
      try {
        if (!handler) throw new Error(`no handler registered for job type '${job.type}'`);
        await handler(job);
        await completeJob(job.id);
      } catch (e) {
        const error = (e as Error).message;
        if (job.attempts >= job.max_attempts) {
          await deadJob(job.id, error);
          console.error(`[jobs] job dead id=${job.id} type=${job.type} after ${job.attempts} attempts: ${error}`);
        } else {
          const backoff = JOB_RETRY_BACKOFF_MS[Math.min(job.attempts - 1, JOB_RETRY_BACKOFF_MS.length - 1)];
          await retryJob(job.id, new Date(Date.now() + backoff), error);
          console.log(`[jobs] retry id=${job.id} type=${job.type} attempt=${job.attempts}/${job.max_attempts} backoff=${backoff / 1000}s error=${error}`);
        }
      }
    }
  } catch (e) {
    console.error(`[jobs] sweep failed: ${(e as Error).message}`);
  } finally {
    sweeping = false;
  }
}

export function startJobWorker(): void {
  if (timer) return;
  void runJobsOnce();
  timer = setInterval(() => void runJobsOnce(), JOB_SWEEP_INTERVAL_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  console.log(`[jobs] worker started (every ${JOB_SWEEP_INTERVAL_MS / 1000}s)`);
}

export function stopJobWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
