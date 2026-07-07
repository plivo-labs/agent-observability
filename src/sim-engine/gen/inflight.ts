/**
 * In-process concurrency cap for scenario generation.
 *
 * A single generate request fans out to roughly `max_scenarios` parallel writer
 * LLM calls; without a ceiling a burst of concurrent requests multiplies that
 * into unbounded LLM spend (a cost-DoS, especially if the endpoint is ever
 * reachable unauthenticated). This is a plain in-process counter — the API runs
 * multiple instances behind a load balancer, so it bounds per-instance load, not
 * a global quota (a true per-user quota lives upstream where user identity is
 * known). `tryAcquire` returns false at the limit; the route answers 429 and the
 * caller retries. Always pair a successful acquire with `release()` in a finally.
 */
let inFlight = 0;

export function tryAcquireGenerationSlot(max: number): boolean {
  if (inFlight >= max) return false;
  inFlight++;
  return true;
}

export function releaseGenerationSlot(): void {
  if (inFlight > 0) inFlight--;
}

/** Current in-flight generation count (for tests / diagnostics). */
export function generationInFlight(): number {
  return inFlight;
}
