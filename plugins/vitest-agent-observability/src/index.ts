/**
 * Vitest Reporter that uploads LiveKit-agents eval results to agent-observability.
 *
 * Usage:
 *
 *   // vitest.config.ts
 *   import { defineConfig } from 'vitest/config';
 *   import AgentObservability from 'vitest-agent-observability';
 *
 *   export default defineConfig({
 *     test: {
 *       setupFiles: ['vitest-agent-observability/setup'],
 *       reporters: ['default', new AgentObservability()],
 *     },
 *   });
 *
 * Inside tests, call `captureRunResult(result)` after `session.run(...)`:
 *
 *   import { captureRunResult } from 'vitest-agent-observability';
 *   it('greets', async () => {
 *     const result = captureRunResult(await session.run({ userInput: 'hi' }));
 *     result.expect.nextEvent().isMessage({ role: 'assistant' });
 *   });
 *
 * `.judge(...)` calls on LiveKit's assertion API are captured automatically.
 */

import path from "node:path";
import { detectCi } from "./ci.js";
import * as collector from "./collector.js";
import { buildPayload } from "./payload.js";
import {
  upload,
  configFromEnv,
  type UploadConfig,
  type Logger,
  defaultLogger,
} from "./uploader.js";
import { installJudgeWrapper } from "./judge.js";
import { installAutocaptureWrapper } from "./autocapture.js";
import type {
  EvalCase,
  Failure,
  ReporterOptions,
  CaseStatus,
  RunEvent,
  JudgmentResult,
} from "./types.js";
import type { TaskAgentObsMeta } from "./collector.js";

export { captureRunResult, recordJudgment } from "./collector.js";
export { flushTaskMeta } from "./collector.js";
export type {
  EvalCase,
  EvalPayloadV0,
  EvalRun,
  Failure,
  JudgmentResult,
  RunEvent,
  ReporterOptions,
} from "./types.js";

// ── Structural Vitest types — avoids a hard peer import. ────────────────────

interface TaskLike {
  id?: string;
  name: string;
  type: "test" | "suite" | "benchmark" | string;
  file?: { filepath?: string } | null;
  mode?: "run" | "skip" | "only" | "todo";
  result?: {
    state?: "pass" | "fail" | "run" | "skip" | "todo" | "only";
    duration?: number;
    errors?: Array<{ message?: string; stack?: string; name?: string }>;
    startTime?: number;
  };
  tasks?: TaskLike[];
  meta?: any;
}

interface FileLike extends TaskLike {
  filepath?: string;
}

// ── Reporter ────────────────────────────────────────────────────────────────

export default class AgentObservabilityReporter {
  private opts: ReporterOptions;
  private uploadConfig: UploadConfig | null;
  private collector: collector.RunCollector | null = null;
  private restoreJudge: (() => void) | null = null;
  private restoreAutocapture: (() => void) | null = null;
  private logger: Logger;

  constructor(opts: ReporterOptions = {}) {
    this.opts = opts;
    this.logger = defaultLogger;
    this.uploadConfig = this.resolveConfig(opts);
  }

  async onInit(_ctx: unknown): Promise<void> {
    if (!this.uploadConfig) return;
    this.collector = collector.newRun(Date.now() / 1000, detectCi());
    // The setup file also installs these in each worker (where tests
    // actually run); installing here is a belt-and-suspenders for users
    // who skip the setupFile entry — both installers are idempotent.
    this.restoreJudge = await installJudgeWrapper(this.logger);
    this.restoreAutocapture = await installAutocaptureWrapper(this.logger);
  }

  async onFinished(
    files: FileLike[] | undefined,
    _errors: unknown[] | undefined,
  ): Promise<void> {
    try {
      if (!this.uploadConfig || !this.collector) return;

      const cases: EvalCase[] = [];
      walkFiles(files ?? [], (test, file) => {
        cases.push(this.buildCase(test, file));
      });
      this.collector.cases = cases;

      const payload = buildPayload({
        collector: this.collector,
        agentId: this.opts.agentId ?? process.env.AGENT_OBSERVABILITY_AGENT_ID ?? null,
        accountId: this.opts.accountId ?? process.env.AGENT_OBSERVABILITY_ACCOUNT_ID ?? null,
        finishedAt: Date.now() / 1000,
      });

      const fallbackDir =
        this.opts.fallbackDir ??
        path.join(".vitest-cache", "agent-observability");
      const ok = await upload(payload, this.uploadConfig, {
        fallbackDir,
        logger: this.logger,
      });
      this.printSummary(payload.run.run_id, ok, fallbackDir);
    } finally {
      if (this.restoreJudge) {
        try { this.restoreJudge(); } catch { /* ignore */ }
        this.restoreJudge = null;
      }
      if (this.restoreAutocapture) {
        try { this.restoreAutocapture(); } catch { /* ignore */ }
        this.restoreAutocapture = null;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Emit the run_id + dashboard URL alongside Vitest's final output. */
  private printSummary(runId: string, ok: boolean, fallbackDir: string | null): void {
    if (!this.uploadConfig || !this.logger.info) return;
    if (ok) {
      const baseUrl = this.uploadConfig.url.replace(/\/$/, "");
      this.logger.info(`Run uploaded: ${runId}`);
      this.logger.info(`View at:      ${baseUrl}/evals/${runId}`);
    } else {
      this.logger.warn(`Run upload failed: ${runId}`);
      if (fallbackDir) {
        this.logger.warn(`Payload saved: ${path.join(fallbackDir, `${runId}.json`)}`);
      }
    }
  }

  private resolveConfig(opts: ReporterOptions): UploadConfig | null {
    if (opts.url) {
      const user = opts.basicAuth?.user ?? process.env.AGENT_OBSERVABILITY_USER;
      const pass = opts.basicAuth?.pass ?? process.env.AGENT_OBSERVABILITY_PASS;
      return {
        url: opts.url,
        basicAuth: user && pass ? { user, pass } : null,
        timeoutMs: opts.timeoutMs ?? 10_000,
        maxRetries: opts.maxRetries ?? 3,
      };
    }
    return configFromEnv();
  }

  private buildCase(task: TaskLike, file: FileLike): EvalCase {
    const meta: TaskAgentObsMeta | undefined = task.meta?.agentObs;
    const events: RunEvent[] = meta?.events ?? [];
    const judgments: JudgmentResult[] = meta?.judgments ?? [];
    const userInput = meta?.user_input;

    const state = task.result?.state;
    let status: CaseStatus;
    if (state === "skip" || state === "todo" || task.mode === "skip" || task.mode === "todo") {
      status = "skipped";
    } else if (state === "pass") {
      status = "passed";
    } else if (state === "fail") {
      status = "failed";
    } else {
      status = "errored";
    }

    let failure: Failure | null = null;
    const errs = task.result?.errors;
    if (errs && errs.length > 0) {
      const e = errs[0]!;
      const message = e.message ?? "";
      const kind: Failure["kind"] =
        message.includes("Judgement failed") ||
        judgments.some((j) => j.verdict === "fail")
          ? "judge_failed"
          : e.name === "AssertionError"
            ? "assertion"
            : "error";
      failure = { kind, message, stack: e.stack };
    }

    return {
      case_id: collector.randomUuid(),
      name: task.name,
      file: file.filepath ?? file.file?.filepath ?? undefined,
      status,
      duration_ms: Math.round(task.result?.duration ?? 0),
      user_input: userInput,
      events,
      judgments,
      failure,
    };
  }
}

// ── Task tree walking ────────────────────────────────────────────────────────

function walkFiles(
  files: FileLike[],
  visit: (test: TaskLike, file: FileLike) => void,
): void {
  for (const file of files) {
    walkTask(file, file, visit);
  }
}

function walkTask(
  task: TaskLike,
  file: FileLike,
  visit: (test: TaskLike, file: FileLike) => void,
): void {
  if (task.type === "test" || task.type === "benchmark") {
    visit(task, file);
    return;
  }
  for (const child of task.tasks ?? []) {
    walkTask(child, file, visit);
  }
}
