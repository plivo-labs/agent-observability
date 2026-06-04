/* run-persistence.ts — survive a browser refresh for in-progress / just-finished runs.
 *
 * The only server-recoverable handle in the system is the Truman suiteId (PK of
 * sim_live_suites, re-fetched via getSuiteStatus). Live suites and Simulate
 * voice / text_then_voice suites all key off it. The synchronous text simulation
 * has NO server handle, so we snapshot its finished SimResult; if it was
 * interrupted mid-flight we offer a re-run rather than fabricate a recovered run.
 *
 * Two independent per-module keys so the Live and Simulate tabs never clobber
 * each other; a version field self-invalidates stale blobs after a shape change. */
import type { RunConfig } from './simulate-page'
import type { SimResult } from './sim-data'

const LIVE_KEY = 'ao.live.run'
const SIM_KEY = 'ao.sim.run'
const VERSION = 1

export interface LiveRun { v: number; suiteId: string; phoneNo?: string; startedAt?: number }
export interface SimRun { v: number; config: RunConfig; escalated?: boolean; suiteId?: string; lastResult?: SimResult }

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

export const readLiveRun = (): LiveRun | null => read<LiveRun>(LIVE_KEY)
export const writeLiveRun = (r: { suiteId: string; phoneNo?: string; startedAt?: number }): void => persist(LIVE_KEY, r)
export const clearLiveRun = (): void => clear(LIVE_KEY)

export const readSimRun = (): SimRun | null => read<SimRun>(SIM_KEY)
// Merge-patch: callers add suiteId / lastResult / escalated as they become
// available. We never persist without a config (nothing to restore from).
export function writeSimRun(patch: Partial<Omit<SimRun, 'v'>>): void {
  const prev = readSimRun()
  const next = { ...(prev ?? {}), ...patch }
  if (!next.config) return
  persist(SIM_KEY, next as Record<string, unknown>)
}
export const clearSimRun = (): void => clear(SIM_KEY)
