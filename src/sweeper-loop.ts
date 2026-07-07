/**
 * Shared timer harness for background sweeps (the alert sweeper and the goal
 * analyzer). It owns only the interval lifecycle: an immediate first run, a
 * steady interval, `unref()` so it never holds the process open at shutdown,
 * and a start log. The re-entrancy guard and the actual per-sweep work stay in
 * the caller's `runOnce`, and the caller keeps its own handle for idempotent
 * start/stop.
 */
export interface SweeperHandle {
  stop(): void;
}

export function startSweeper(
  runOnce: () => Promise<void>,
  intervalMs: number,
  label: string,
): SweeperHandle {
  // Immediate first run, then the steady interval.
  void runOnce();
  const timer = setInterval(() => void runOnce(), intervalMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  console.log(`[${label}] sweeper started (every ${intervalMs / 1000}s)`);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
