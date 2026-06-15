/**
 * 0.4 — generic job queue against real Postgres. Covers idempotent enqueue,
 * the atomic claim + lease (a claimed job isn't immediately re-claimable),
 * attempt increment, and the completed/retry transitions. The worker-loop
 * orchestration (dispatch/backoff/dead) is unit-tested in tests/jobs.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { enqueueJob, claimJobs, completeJob, retryJob } from "../src/jobs/db.js";
import { describeDb } from "./helpers.js";

describeDb("job queue", () => {
  const TYPE = `itest.job.${Date.now().toString(36)}`;

  beforeAll(async () => {
    await migrate(sql); // idempotent — ensures migration 020 is applied
    await sql`DELETE FROM jobs WHERE type = ${TYPE}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM jobs WHERE type = ${TYPE}`;
  });

  test("enqueue → claim increments attempts and leases the row", async () => {
    const id = await enqueueJob(TYPE, { n: 1 });
    expect(id).toBeTruthy();

    const claimed = await claimJobs(50);
    const mine = claimed.filter((j) => j.type === TYPE);
    expect(mine.length).toBe(1);
    expect(mine[0].attempts).toBe(1);
    expect(mine[0].payload).toEqual({ n: 1 });

    // Immediately re-claiming returns nothing for this row — it's leased.
    const again = (await claimJobs(50)).filter((j) => j.id === id);
    expect(again.length).toBe(0);

    await completeJob(id!);
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
    expect(row.status).toBe("done");
  });

  test("idempotency_key makes a redelivered enqueue a no-op", async () => {
    const key = `${TYPE}-key-1`;
    const first = await enqueueJob(TYPE, { v: "a" }, { idempotencyKey: key });
    const second = await enqueueJob(TYPE, { v: "b" }, { idempotencyKey: key });
    expect(first).toBeTruthy();
    expect(second).toBeNull(); // suppressed by ON CONFLICT DO NOTHING

    const rows = await sql`SELECT id FROM jobs WHERE idempotency_key = ${key}`;
    expect(rows.length).toBe(1);
  });

  test("retryJob makes the job due again for another claim", async () => {
    const id = await enqueueJob(TYPE, { retry: true });
    await claimJobs(50); // claim + lease it
    await retryJob(id!, new Date(Date.now() - 1000), "transient"); // due 1s ago

    const reclaimed = (await claimJobs(50)).filter((j) => j.id === id);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].attempts).toBe(2); // incremented again on the second claim
    expect(reclaimed[0].last_error).toBe("transient");
  });
});
