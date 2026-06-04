// Pure read-time overlay helpers for eval runs. Factored out of db.ts so
// unit tests don't have to drag in `bun:sql` + env config just to verify
// the staleness logic.
//
// Why a TTL and not heartbeats:
//   - Graceful pytest failures (test failures, Ctrl+C, internal errors)
//     all fire pytest_sessionfinish, which posts a terminal status. No
//     liveness signal is needed for those.
//   - The only uncovered case is a hard kill (SIGKILL, OOM, machine
//     death) where no Python code runs. For those, a server-managed
//     last_activity_at + read-time TTL self-heals the dashboard without
//     a background thread or extra endpoint.
//   - 1 hour is well past any reasonable run duration but short enough
//     that stuck rows clear in roughly one CI cycle.

export const EVAL_RUN_STALE_ACTIVITY_MS = 60 * 60 * 1000; // 1 hour

/** Pure overlay: stored DB status → effective status visible to clients. */
export function deriveRunStatus(
  storedStatus: string,
  lastActivityAt: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  if (storedStatus !== "running") return storedStatus;
  if (!lastActivityAt) return storedStatus;
  const la =
    lastActivityAt instanceof Date ? lastActivityAt : new Date(lastActivityAt);
  if (Number.isNaN(la.getTime())) return storedStatus;
  const ageMs = now.getTime() - la.getTime();
  return ageMs > EVAL_RUN_STALE_ACTIVITY_MS ? "completed" : storedStatus;
}
