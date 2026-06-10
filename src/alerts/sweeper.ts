import { claimDueFirings, markDelivered, markFailed, markRetry } from "./db.js";
import { deliverFiring, MAX_ATTEMPTS, RETRY_BACKOFF_MS } from "./deliver.js";
import { evaluateRules } from "./engine.js";

// ── Alert sweeper ───────────────────────────────────────────────────────────
//
// Time-driven loop: every SWEEP_INTERVAL_MS, (1) evaluate all rule
// conditions over their trailing windows, (2) deliver due firings with
// bounded concurrency. All state lives in Postgres, so retries survive
// restarts. Single-instance design — add FOR UPDATE SKIP LOCKED claiming
// before running multiple server replicas.

export const SWEEP_INTERVAL_MS = 30_000;
const DELIVERY_CONCURRENCY = 5;

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export async function runSweepOnce(): Promise<void> {
  if (sweeping) return; // re-entrancy guard: a slow sweep can't stack
  sweeping = true;
  try {
    await evaluateRules();

    const due = await claimDueFirings(50);
    // Bounded concurrency: a batch of timing-out endpoints delays other
    // deliveries by at most timeout × (batch / concurrency), not × batch.
    for (let i = 0; i < due.length; i += DELIVERY_CONCURRENCY) {
      const chunk = due.slice(i, i + DELIVERY_CONCURRENCY);
      await Promise.all(
        chunk.map(async (d) => {
          try {
            const result = await deliverFiring(d);
            if (result.ok) {
              await markDelivered(d.id, result.status);
              return;
            }
            const attempts = d.attempt_count + 1;
            if (attempts >= MAX_ATTEMPTS) {
              await markFailed(d.id, result.error, result.status);
              console.error(
                `[alerts] delivery exhausted firing=${d.id} rule=${d.rule_id} after ${attempts} attempts: ${result.error}`,
              );
            } else {
              const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
              await markRetry(d.id, new Date(Date.now() + backoff), result.error, result.status);
            }
          } catch (e) {
            console.error(`[alerts] delivery error firing=${d.id}: ${(e as Error).message}`);
          }
        }),
      );
    }
  } catch (e) {
    console.error(`[alerts] sweep failed: ${(e as Error).message}`);
  } finally {
    sweeping = false;
  }
}

export function startAlertSweeper(): void {
  if (timer) return;
  // Immediate first run, then the steady interval. unref() keeps the
  // timer from holding the process open on shutdown.
  void runSweepOnce();
  timer = setInterval(() => void runSweepOnce(), SWEEP_INTERVAL_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  console.log(`[alerts] sweeper started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
}

export function stopAlertSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
