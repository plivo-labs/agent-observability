/**
 * Background-worker entrypoint — same codebase as the REST API, different
 * process. An infinite job loop: each iteration evaluates alert rules and
 * delivers due webhooks, then sleeps. No ports, no HTTP — liveness is the
 * process itself (and the sweep logs).
 *
 *   bun src/worker.ts
 *
 * Pair it with ALERT_SWEEPER=off on the API process so only one sweeper
 * burns cycles. (Running two is safe — suppression stamps and delivery
 * claims are atomic — just wasteful.)
 *
 * Migrations stay API-owned (AUTO_MIGRATE on the API): the worker never
 * migrates, so there is no startup race between the two entrypoints.
 * Future background jobs (rollups, retention, online judges) slot into
 * the same loop.
 */

import { runSweepOnce, SWEEP_INTERVAL_MS } from "./alerts/sweeper.js";

let running = true;

function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — finishing current sweep, then exiting`);
  running = false;
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[worker] started — sweeping every ${SWEEP_INTERVAL_MS / 1000}s`);

while (running) {
  await runSweepOnce();
  // Sleep in small slices so a shutdown signal is honored within ~1s
  // instead of waiting out the full interval.
  for (let waited = 0; running && waited < SWEEP_INTERVAL_MS; waited += 1000) {
    await Bun.sleep(1000);
  }
}

console.log("[worker] stopped");
process.exit(0);
