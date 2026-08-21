/**
 * Regression tests for the 2026-08-17 us-east judging outage.
 *
 * Every sweeper runs its tick through a concurrency gate whose slot is released
 * in a `finally` — which runs when work SETTLES, not when it HANGS. One
 * never-settling await held the slot for the life of the process: every
 * subsequent tick returned at the gate, 12,565 sessions went unjudged for three
 * days, and nothing was logged because nothing ever threw.
 *
 * These test the primitives directly rather than through a sweeper. That is
 * deliberate: `tests/` shares one module registry and one set of module-level
 * singletons, so a sweeper-level test would depend on file order — exactly the
 * kind of thing that passes locally and fails in CI. The latch lives in
 * createRunGate so it can be tested without any of that.
 */
import { describe, test, expect } from "bun:test";
import { withDeadline, createRunGate, DeadlineExceededError } from "../src/deadline.js";

/** The hang: an await that never settles, like a wedged DB socket or a provider
 *  call whose response never arrives. */
const never = () => new Promise<never>(() => {});
const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withDeadline", () => {
  test("passes the value through when work finishes in time", async () => {
    expect(await withDeadline("fast work", 1000, async () => "ok")).toBe("ok");
  });

  test("propagates the work's own rejection unchanged", async () => {
    const boom = new Error("provider said no");
    await expect(
      withDeadline("failing work", 1000, () => Promise.reject(boom)),
    ).rejects.toBe(boom);
  });

  test("rejects with DeadlineExceededError when the work never settles", async () => {
    // The outage in one line: without this, the await below hangs forever.
    const err = await withDeadline("wedged work", 20, never).catch((e) => e);
    expect(err).toBeInstanceOf(DeadlineExceededError);
    expect(err.label).toBe("wedged work");
    expect(err.ms).toBe(20);
    // The message is what a human reads in the log line that finally makes the
    // hang visible — keep it self-explanatory.
    expect(err.message).toContain("wedged work");
    expect(err.message).toContain("deadline");
  });

  test("renders the budget in seconds, and in ms below a second", () => {
    expect(new DeadlineExceededError("x", 900_000).message).toContain("900s");
    expect(new DeadlineExceededError("x", 50).message).toContain("50ms");
  });

  test("runs registered cleanup even when the work is abandoned", async () => {
    // Load-bearing: judgeClaimed arms a 60s claim heartbeat. On the deadline
    // path its own `finally` never runs, and an orphaned heartbeat re-asserts
    // ownership forever — the claim never goes stale, so no sweeper ever
    // retries it. Six us-east claims were found frozen exactly that way.
    let beats = 0;
    const timer = setInterval(() => { beats += 1; }, 5);
    await withDeadline("hung work with a timer", 20, (register) => {
      register(() => clearInterval(timer));
      return never();
    }).catch(() => {});
    const atDeadline = beats;
    await after(40);
    expect(beats).toBe(atDeadline); // stopped, not still ticking
  });

  test("runs registered cleanup on the success and failure paths too", async () => {
    let cleaned = 0;
    await withDeadline("ok", 1000, (register) => {
      register(() => { cleaned += 1; });
      return Promise.resolve(1);
    });
    await withDeadline("boom", 1000, (register) => {
      register(() => { cleaned += 1; });
      return Promise.reject(new Error("x"));
    }).catch(() => {});
    expect(cleaned).toBe(2);
  });

  test("a throwing cleanup does not mask the outcome", async () => {
    const value = await withDeadline("ok", 1000, (register) => {
      register(() => { throw new Error("teardown blew up"); });
      return Promise.resolve("survived");
    });
    expect(value).toBe("survived");
  });

  test("abandoned work rejecting later is not an unhandled rejection", async () => {
    // Bun/Node kills the process on an unhandled rejection under strict modes,
    // so a hang that later errors out must not become a second outage.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await withDeadline("slow work", 10, () =>
        after(30).then(() => {
          throw new Error("late failure nobody is waiting for");
        }),
      ).catch(() => {});
      await after(80); // outlive the abandoned work + a rejection-report tick
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("createRunGate", () => {
  const swallow = () => {};

  test("a hung run releases its slot — the next tick still executes", async () => {
    // THE regression. Pre-fix the guard was a bare `let sweeping` released in a
    // `finally`, so this second run never happened — not on the next tick, not
    // ever, for the life of the process.
    const gate = createRunGate({ limit: 1, timeoutMs: 20 });
    await gate("wedged tick", never, swallow);

    let ran = false;
    await gate("next tick", async () => { ran = true; }, swallow);
    expect(ran).toBe(true);
  });

  test("holds the slot while a run is genuinely in flight", async () => {
    // The gate must still do its original job: a slow tick can't stack.
    const gate = createRunGate({ limit: 1, timeoutMs: 5000 });
    let overlapped = false;
    const slow = gate("slow tick", () => after(40), swallow);
    await gate("concurrent tick", async () => { overlapped = true; }, swallow);
    expect(overlapped).toBe(false);
    await slow;
  });

  test("counts slots, so a saturated gate drops calls and recovers", async () => {
    // The event-kick shape: MAX_CONCURRENT_KICKS hung kicks used to peg the
    // counter permanently and silently disable the push path.
    const gate = createRunGate({ limit: 3, timeoutMs: 20 });
    const hung = [gate("a", never, swallow), gate("b", never, swallow), gate("c", never, swallow)];
    let dropped = true;
    await gate("d", async () => { dropped = false; }, swallow);
    expect(dropped).toBe(true); // full → dropped, poller covers it

    await Promise.all(hung); // all three time out and free their slots
    let ran = false;
    await gate("e", async () => { ran = true; }, swallow);
    expect(ran).toBe(true);
  });

  test("routes the deadline and the work's own errors to onError, never rejecting", async () => {
    // A background loop must not reject into a timer callback.
    const seen: Error[] = [];
    const gate = createRunGate({ limit: 1, timeoutMs: 20 });
    await gate("wedged tick", never, (e) => seen.push(e));
    await gate("broken tick", () => Promise.reject(new Error("db down")), (e) => seen.push(e));
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeInstanceOf(DeadlineExceededError);
    expect(seen[1]?.message).toBe("db down");
  });

  test("releases the slot after an error, not just after a hang", async () => {
    const gate = createRunGate({ limit: 1, timeoutMs: 5000 });
    await gate("broken tick", () => Promise.reject(new Error("db down")), swallow);
    let ran = false;
    await gate("next tick", async () => { ran = true; }, swallow);
    expect(ran).toBe(true);
  });
});
