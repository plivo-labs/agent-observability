import { AsyncLocalStorage } from "node:async_hooks";

const deadlineSignal = new AsyncLocalStorage<AbortSignal>();

// Nested judges share the session's budget without changing non-sweeper callers.
export function currentDeadlineSignal(): AbortSignal | undefined {
  return deadlineSignal.getStore();
}

export async function withAbort<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // The race handles late rejections even if the provider ignores cancellation.
    return await Promise.race([aborted, work()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded its ${ms}ms deadline`);
    this.name = "DeadlineExceededError";
  }
}

export async function withDeadline<T>(label: string, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const parent = currentDeadlineSignal();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DeadlineExceededError(label, ms)), ms);
  timer.unref();
  try {
    return await deadlineSignal.run(signal, () => withAbort(signal, () => work(signal)));
  } finally {
    clearTimeout(timer);
    // Promise.all can fail while sibling judges still hold slots or heartbeats.
    controller.abort(new Error(`${label} finished`));
  }
}

export function createRunGate(opts: { limit: number; timeoutMs: number }) {
  let active = 0;
  return async (label: string, work: (signal: AbortSignal) => Promise<unknown>, onError: (error: Error) => void): Promise<void> => {
    if (active >= opts.limit) return;
    active++;
    try {
      await withDeadline(label, opts.timeoutMs, work);
    } catch (error) {
      onError(error as Error);
    } finally {
      active--;
    }
  };
}

/** Each worker judges up to ceil(maxPerSweep / maxConcurrentSessions) sessions back to back; a shorter
 *  sweep deadline would abort healthy sessions mid-judgement and waste their spend. */
export function sweepDeadlineMs(configuredMs: number, maxPerSweep: number, maxConcurrentSessions: number, sessionTimeoutMs: number): number {
  const rounds = Math.ceil(maxPerSweep / maxConcurrentSessions);
  return Math.max(configuredMs, (rounds + 1) * sessionTimeoutMs);
}

