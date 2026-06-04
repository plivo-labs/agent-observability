import { serializeEvents } from "./events.js";
import type { JudgmentResult, RunEvent } from "./types.js";

/**
 * Per-worker capture state. Each test file runs in its own worker (or
 * isolated context), so module-level state here is local to the currently
 * running test. An `afterEach` hook (see `setup.ts`) flushes this state into
 * `task.meta.agentObs` so the main-process reporter can read it.
 */
interface Bucket {
  runResults: unknown[];
  judgments: JudgmentResult[];
}

const pending: Bucket = { runResults: [], judgments: [] };

/** Users call this inside a test to record a LiveKit RunResult.
 * Idempotent by reference — calling it explicitly AND via the auto-capture
 * wrapper on the same RunResult produces a single entry, so events aren't
 * double-serialized. */
export function captureRunResult<T>(runResult: T): T {
  if (runResult == null) return runResult;
  if (pending.runResults.indexOf(runResult as unknown) !== -1) return runResult;
  pending.runResults.push(runResult);
  return runResult;
}

/** Called by the judge wrapper (or advanced users) to record a judgment verdict. */
export function recordJudgment(j: JudgmentResult): void {
  pending.judgments.push(j);
}

/** Meta shape attached to each Vitest task by `flushTaskMeta`. */
export interface TaskAgentObsMeta {
  events: RunEvent[];
  user_input?: string;
  judgments: JudgmentResult[];
}

/**
 * Serialize pending captures and attach to `ctx.task.meta.agentObs`.
 * Called by the setup-file's `afterEach` hook. Drains pending state.
 */
export function flushTaskMeta(ctx: { task: any } | undefined | null): void {
  try {
    const task = ctx?.task;
    if (!task) {
      reset();
      return;
    }
    const events: RunEvent[] = [];
    const userInputs: string[] = [];
    for (const rr of pending.runResults) {
      const ui =
        (rr as any)?._user_input
          ?? (rr as any)?.user_input
          ?? (rr as any)?.userInput;
      if (typeof ui === "string" && ui.length > 0) userInputs.push(ui);
      const evs = ((rr as any)?.events as unknown[] | undefined) ?? [];
      events.push(...serializeEvents(evs));
    }
    task.meta ??= {};
    task.meta.agentObs = {
      events,
      user_input: userInputs.length > 0 ? userInputs.join("\n") : undefined,
      judgments: pending.judgments.slice(),
    } satisfies TaskAgentObsMeta;
  } finally {
    reset();
  }
}

/** Visible for testing. */
export function reset(): void {
  pending.runResults.length = 0;
  pending.judgments.length = 0;
}

/** Visible for testing. */
export function peekPending(): Readonly<Bucket> {
  return pending;
}

// ── Run-level collector (reporter-side) ─────────────────────────────────────

export interface RunCollector {
  run_id: string;
  started_at: number;
  finished_at: number | null;
  ci: unknown;
  cases: import("./types.js").EvalCase[];
}

export function newRun(started_at: number, ci: unknown): RunCollector {
  return {
    run_id: randomUuid(),
    started_at,
    finished_at: null,
    ci,
    cases: [],
  };
}

export function randomUuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Math.floor(n).toString(16).padStart(4, "0");
  return `${hex(Date.now() & 0xffff)}${hex(Math.random() * 0xffff)}-${hex(
    Math.random() * 0xffff,
  )}-4${hex(Math.random() * 0xfff).slice(0, 3)}-${hex(Math.random() * 0xffff)}-${hex(
    Math.random() * 0xffff,
  )}${hex(Math.random() * 0xffff)}${hex(Math.random() * 0xffff)}`;
}
