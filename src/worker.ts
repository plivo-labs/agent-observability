/**
 * Background-worker entrypoint — same codebase as the REST API, different
 * process. An infinite loop: each iteration evaluates alert rules + delivers
 * due webhooks AND processes due generic jobs (eval runs, simulations), then
 * sleeps. No ports, no HTTP — liveness is the process itself (and the logs).
 *
 *   bun src/worker.ts
 *
 * Pair it with ALERT_SWEEPER=off and JOBS_WORKER=off on the API process so
 * each loop runs in exactly one place. (Running two is safe — claims and
 * suppression stamps are atomic — just wasteful.)
 *
 * Migrations stay API-owned (AUTO_MIGRATE on the API): the worker never
 * migrates, so there is no startup race between the two entrypoints.
 */

import { runSweepOnce, SWEEP_INTERVAL_MS } from "./alerts/sweeper.js";
import { runJobsOnce } from "./jobs/worker.js";

let running = true;

function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — finishing current cycle, then exiting`);
  running = false;
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[worker] started — alert sweep + job loop every ${SWEEP_INTERVAL_MS / 1000}s`);

while (running) {
  await runSweepOnce();
  await runJobsOnce();
  // Sleep in small slices so a shutdown signal is honored within ~1s
  // instead of waiting out the full interval.
  for (let waited = 0; running && waited < SWEEP_INTERVAL_MS; waited += 1000) {
    await Bun.sleep(1000);
  }
}

console.log("[worker] stopped");
process.exit(0);
