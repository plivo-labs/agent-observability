/* jobs.ts — server-side simulation JOB registry.
 *
 * Text simulations used to run entirely inside the React page (the page drove
 * `runSimulation` / `runSimulationStream` itself). That meant a refresh or an
 * in-app navigation (Monitor → back to Simulate) unmounted the controller and
 * aborted the run — there was no server-side handle to reconnect to, so the UI
 * could only offer a "Re-run".
 *
 * This module gives a run a server-recoverable handle: a `jobId`. The route
 * starts `runSimulation(...)` in the BACKGROUND, streaming engine events into a
 * module-level `Map<jobId, JobState>`. The client polls `GET /api/simulations/
 * jobs/:id` (~1s) to drive its live UI, and on a refresh / nav re-fetches the
 * same jobId to resume — running, or already done with the full result.
 *
 * In-memory only (no DB): a cap + TTL keep it bounded. A backend restart clears
 * the map (that's the one case the client genuinely falls back to "Re-run").
 */
import type { SimResult, PersonaType, CaseStatus } from "./engine.js";

export interface JobTurn { role: "agent" | "user"; t: string; ms: number | null; flag: string | null }
export interface JobCase {
  index: number;
  personaName: string;
  personaType: PersonaType;
  status?: CaseStatus;
  score?: number;
  turns: JobTurn[];
}
export interface JobState {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  updatedAt: number;
  cases: JobCase[];
  result?: SimResult;
  runId?: string | null;
  error?: string;
}

/** Keep the registry bounded: at most MAX_JOBS live entries, and drop any job
 *  untouched for longer than TTL_MS. Both are evaluated lazily on each create. */
const MAX_JOBS = 50;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

const jobs = new Map<string, JobState>();
// Abort handles, kept OUT of JobState so the GET /jobs/:id JSON response stays
// clean (an AbortController serializes to junk). One per running job.
const controllers = new Map<string, AbortController>();

/** Drop expired jobs, then (if still over the cap) the oldest by `updatedAt`. */
function prune(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.updatedAt > TTL_MS) { jobs.delete(id); controllers.delete(id); }
  }
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const j of ordered.slice(0, jobs.size - MAX_JOBS)) { jobs.delete(j.id); controllers.delete(j.id); }
}

export function createJob(id: string): JobState {
  prune();
  const now = Date.now();
  const job: JobState = { id, status: "running", startedAt: now, updatedAt: now, cases: [] };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

/** Register the AbortController driving a running job so it can be cancelled. */
export function setJobController(id: string, ctrl: AbortController): void {
  controllers.set(id, ctrl);
}

/** Cancel a running job: abort its work and mark it `cancelled`. Returns false
 *  if the job is unknown or already terminal (nothing to cancel). */
export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return false;
  controllers.get(id)?.abort();
  controllers.delete(id);
  j.status = "cancelled";
  j.updatedAt = Date.now();
  return true;
}

/** Mutate a job in place and bump `updatedAt`. No-op if the job is gone. */
export function updateJob(id: string, mutate: (j: JobState) => void): void {
  const j = jobs.get(id);
  if (!j) return;
  mutate(j);
  j.updatedAt = Date.now();
}
