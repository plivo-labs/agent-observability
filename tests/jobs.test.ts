import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the DB layer so we test the worker orchestration (claim → dispatch →
// complete/retry/dead) without a database — mirrors tests/alerts-sweeper.test.ts.
const claimJobs = mock(async (_limit?: number) => [] as any[]);
const completeJob = mock(async (_id: string) => {});
const retryJob = mock(async (_id: string, _at: Date, _err: string) => {});
const deadJob = mock(async (_id: string, _err: string) => {});

mock.module("../src/jobs/db.js", () => ({ claimJobs, completeJob, retryJob, deadJob }));

const { runJobsOnce, registerJobHandler, clearJobHandlers, JOB_RETRY_BACKOFF_MS } = await import(
  "../src/jobs/worker.js"
);

function makeJob(over: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    type: "test.job",
    payload: { hello: "world" },
    status: "pending",
    attempts: 1,
    max_attempts: 6,
    next_attempt_at: new Date().toISOString(),
    last_error: null,
    ...over,
  };
}

beforeEach(() => {
  claimJobs.mockReset();
  completeJob.mockReset();
  retryJob.mockReset();
  deadJob.mockReset();
  clearJobHandlers();
});

describe("runJobsOnce", () => {
  test("dispatches to the handler and marks the job done on success", async () => {
    const job = makeJob();
    claimJobs.mockImplementation(async () => [job]);
    const handler = mock(async () => {});
    registerJobHandler("test.job", handler);

    await runJobsOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(job as any); // handler receives the full job
    expect(completeJob).toHaveBeenCalledWith("job-1");
    expect(retryJob).not.toHaveBeenCalled();
    expect(deadJob).not.toHaveBeenCalled();
  });

  test("reschedules with backoff when the handler throws and attempts remain", async () => {
    claimJobs.mockImplementation(async () => [makeJob({ attempts: 1, max_attempts: 6 })]);
    registerJobHandler("test.job", async () => {
      throw new Error("boom");
    });

    const before = Date.now();
    await runJobsOnce();

    expect(retryJob).toHaveBeenCalledTimes(1);
    expect(deadJob).not.toHaveBeenCalled();
    const [id, nextAt, err] = retryJob.mock.calls[0];
    expect(id).toBe("job-1");
    expect(err).toBe("boom");
    // attempts=1 → first backoff (30s)
    const delay = (nextAt as Date).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(JOB_RETRY_BACKOFF_MS[0] - 1000);
    expect(delay).toBeLessThanOrEqual(JOB_RETRY_BACKOFF_MS[0] + 2000);
  });

  test("marks the job dead when attempts have reached max_attempts", async () => {
    claimJobs.mockImplementation(async () => [makeJob({ attempts: 6, max_attempts: 6 })]);
    registerJobHandler("test.job", async () => {
      throw new Error("still failing");
    });

    await runJobsOnce();

    expect(deadJob).toHaveBeenCalledWith("job-1", "still failing");
    expect(retryJob).not.toHaveBeenCalled();
  });

  test("treats a missing handler as a failure (retries, not silently dropped)", async () => {
    claimJobs.mockImplementation(async () => [makeJob({ type: "unknown.type", attempts: 1 })]);

    await runJobsOnce();

    expect(retryJob).toHaveBeenCalledTimes(1);
    expect(retryJob.mock.calls[0][2]).toContain("no handler registered");
    expect(completeJob).not.toHaveBeenCalled();
  });

  test("processes every job in the claimed batch", async () => {
    claimJobs.mockImplementation(async () => [
      makeJob({ id: "a" }),
      makeJob({ id: "b" }),
      makeJob({ id: "c" }),
    ]);
    registerJobHandler("test.job", async () => {});

    await runJobsOnce();

    expect(completeJob).toHaveBeenCalledTimes(3);
  });

  test("uses the later backoff entries as attempts climb", async () => {
    claimJobs.mockImplementation(async () => [makeJob({ attempts: 3, max_attempts: 6 })]);
    registerJobHandler("test.job", async () => {
      throw new Error("x");
    });
    const before = Date.now();
    await runJobsOnce();
    const delay = (retryJob.mock.calls[0][1] as Date).getTime() - before;
    // attempts=3 → backoff index 2 (10 min)
    expect(delay).toBeGreaterThanOrEqual(JOB_RETRY_BACKOFF_MS[2] - 1000);
    expect(delay).toBeLessThanOrEqual(JOB_RETRY_BACKOFF_MS[2] + 2000);
  });
});
