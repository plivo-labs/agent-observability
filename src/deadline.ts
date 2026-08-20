/**
 * Hang-safe primitives for background loops.
 *
 * Every sweeper here (evals, alerts, goals) runs at most one tick at a time,
 * guarded by a flag released in a `finally`. That is correct for work that
 * SETTLES — resolve or reject — and silently fatal for work that HANGS:
 * `finally` never runs, the flag stays true for the life of the process, and
 * every later tick returns at the guard. No throw, no log, no alert. The loop
 * is simply dead, and looks idle.
 *
 * Not hypothetical. us-east AO judging stopped at 2026-08-17T15:52Z and stayed
 * stopped for three days this way: replicas latched one at a time (five on
 * Aug 15, the last on Aug 17), 12.5k sessions went unjudged, six claims sat
 * frozen in `running`, and the only symptom was silence — no `sweep failed`,
 * no `eval_error`, no restart. The processes were up and healthy throughout.
 *
 * The fix is that work must ALWAYS settle. `withDeadline` enforces that;
 * `createRunGate` bundles it with the guard so the two can't drift apart
 * again — which is why the guard lives here rather than as a bare `let` in
 * each sweeper.
 *
 * Only the eval sweeper is converted so far. The alert sweeper and the goal
 * analyzer still carry the bare `let sweeping` and the same latent outage;
 * moving them over is a follow-up, kept out of this PR so the fix for a live
 * incident isn't held up by unrelated churn.
 *
 * Neither primitive CANCELS. JavaScript cannot abort an in-flight await, so
 * abandoned work runs to whatever end it reaches and its result is discarded.
 * Two consequences are handled here rather than left to callers:
 *   - the abandoned rejection is swallowed (an orphan must not take the
 *     process down as an unhandled rejection);
 *   - timers the work armed would leak with it, so work receives a `register`
 *     callback and anything it registers is cleared even on the deadline path.
 *     That last part is load-bearing: an orphaned 60s claim heartbeat
 *     re-asserts ownership forever, so the claim never goes stale and no
 *     sweeper ever retries it — the exact state those six us-east claims were
 *     found in.
 */

/** Register a teardown (usually clearInterval) that must run even if the work
 *  is abandoned at its deadline. */
export type RegisterCleanup = (stop: () => void) => void;

/** Thrown when work outlives its deadline. A distinct type so callers can tell
 *  a hang apart from the work's own failures. */
export class DeadlineExceededError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    // Sub-second deadlines only occur in tests, but "exceeded its 0s deadline"
    // reads like a bug — keep the unit honest at both scales.
    const budget = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
    super(`${label} exceeded its ${budget} deadline — abandoned so the loop can continue`);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Run `work`, rejecting with DeadlineExceededError after `ms` if it hasn't
 * settled. Anything `work` registers via its `register` argument is torn down
 * on every path, including the deadline path where the work's own `finally`
 * will never run.
 *
 * `label` names the work in the rejection message — it is what a human reads in
 * the log line that finally makes a hang visible, so make it specific
 * ("eval sweep", "judge session=abc123"), not "task".
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  work: (register: RegisterCleanup) => Promise<T>,
): Promise<T> {
  const teardown: Array<() => void> = [];
  const started = work((stop) => teardown.push(stop));
  // Attached before the race, not after: whichever side loses is abandoned, and
  // an orphaned rejection with no handler is a process-level unhandled
  // rejection. A promise carries any number of handlers, so this never changes
  // what the race observes.
  void started.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms);
        // Never hold the process open at shutdown — same reason the sweeper
        // intervals unref().
        if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
          (timer as unknown as { unref: () => void }).unref();
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    for (const stop of teardown) {
      try {
        stop();
      } catch {
        /* teardown must never mask the outcome */
      }
    }
  }
}

/**
 * A concurrency gate that cannot latch: at most `limit` runs in flight, each
 * deadline-bounded, and the slot is released on every path.
 *
 * Calls made while the gate is full are DROPPED, not queued — every caller here
 * is a poller or a best-effort push whose fallback re-covers the work on the
 * next tick. `limit: 1` is the sweep case (a slow tick can't stack).
 *
 * Errors — the work's own, or the deadline's — go to the per-call `onError` so
 * each site keeps its own log line, and never propagate: a background loop must
 * not reject into a timer callback.
 */
export function createRunGate(opts: { limit: number; timeoutMs: number }) {
  let active = 0;
  return async function run(
    label: string,
    work: (register: RegisterCleanup) => Promise<unknown>,
    onError: (e: Error) => void,
  ): Promise<void> {
    if (active >= opts.limit) return;
    active += 1;
    try {
      await withDeadline(label, opts.timeoutMs, work);
    } catch (e) {
      onError(e as Error);
    } finally {
      active -= 1;
    }
  };
}
