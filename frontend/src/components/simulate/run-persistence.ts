/* run-persistence.ts — survive a browser refresh for in-progress / just-finished runs.
 *
 * The text simulation runs as a SERVER-side job keyed by jobId (POST
 * /api/simulations/jobs), so we persist that handle to resume on refresh /
 * in-app nav; `lastResult` stays as a client-side snapshot of a finished run.
 *
 * A version field self-invalidates stale blobs after a shape change. */
import type { RunConfig } from './simulate-page'
import type { SimResult } from './sim-data'

const SIM_KEY = 'ao.sim.run'
const VERSION = 1

// `jobId` is the SERVER-side handle for a text sim (POST /api/simulations/jobs):
// it survives refresh / in-app nav and lets the page resume the run (or fetch
// its finished result) on mount. `lastResult` stays as a client-side snapshot
// fallback for already-finished runs.
export interface SimRun { v: number; config: RunConfig; jobId?: string; lastResult?: SimResult }

function read<T extends { v: number }>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || obj.v !== VERSION) { localStorage.removeItem(key); return null }
    return obj as T
  } catch { try { localStorage.removeItem(key) } catch { /* ignore */ } return null }
}

function persist(key: string, obj: Record<string, unknown>): void {
  // localStorage can throw (quota exceeded / disabled / private mode) — the run
  // still works this session, it just won't survive a refresh.
  try { localStorage.setItem(key, JSON.stringify({ ...obj, v: VERSION })) } catch { /* ignore */ }
}

function clear(key: string): void { try { localStorage.removeItem(key) } catch { /* ignore */ } }

export const readSimRun = (): SimRun | null => read<SimRun>(SIM_KEY)
// Merge-patch: callers add jobId / lastResult as they become
// available. We never persist without a config (nothing to restore from).
export function writeSimRun(patch: Partial<Omit<SimRun, 'v'>>): void {
  const prev = readSimRun()
  const next = { ...(prev ?? {}), ...patch }
  if (!next.config) return
  persist(SIM_KEY, next as Record<string, unknown>)
}
export const clearSimRun = (): void => clear(SIM_KEY)
