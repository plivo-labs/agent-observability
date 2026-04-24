/**
 * Bun HTTP server that exposes Vitest runs — mirror of `fastapi_runner.py`.
 *
 * Two endpoints, same underlying evals:
 *
 *   POST /run/vitest     — invokes Vitest **in-process** via its Node API
 *                          (`startVitest` from `vitest/node`) against
 *                          `vitest_generated_agent.ts`. A custom reporter
 *                          captures per-test outcomes and durations.
 *
 *   POST /run/scenarios  — skips Vitest entirely and calls the scenario
 *                          runner directly. Same generated scenarios, same
 *                          agent — just returns judged results as JSON.
 *
 * Run:
 *
 *   export OPENAI_API_KEY=sk-...
 *   bun plugins/examples/bun_runner.ts
 *
 * Then:
 *
 *   curl -X POST http://localhost:8080/run/vitest -H content-type:application/json \
 *        -d '{"n": 5}'
 *   curl -X POST http://localhost:8080/run/scenarios -H content-type:application/json \
 *        -d '{"n": 5}'
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Vitest ≥ 1.0 ships a programmatic API under `vitest/node`.
// `startVitest` loads the user's vitest config, registers reporters, and
// returns a controller with a `state` object we can inspect.
import { startVitest } from "vitest/node";

const EXAMPLES_DIR = join(fileURLToPath(new URL(".", import.meta.url)));
const GENERATED_TEST = join(EXAMPLES_DIR, "vitest_generated_agent.ts");

// ── Vitest reporter that captures per-case outcomes ────────────────────────

interface CaseReport {
  id: string;
  name: string;
  outcome: "passed" | "failed" | "skipped" | "pending" | "unknown";
  durationMs: number;
  errorMessage?: string;
}

class JsonReporter {
  public cases: CaseReport[] = [];

  // Vitest passes us the File[] tree on finish. We walk it for leaf tests.
  async onFinished(files: any[] = []): Promise<void> {
    for (const file of files) {
      this.#walk(file, file.name ?? "");
    }
  }

  #walk(task: any, parentName: string): void {
    if (!task) return;
    const fullName = task.name
      ? parentName
        ? `${parentName} > ${task.name}`
        : task.name
      : parentName;

    if (task.type === "test") {
      this.cases.push({
        id: task.id,
        name: fullName,
        outcome: (task.result?.state ?? "unknown") as CaseReport["outcome"],
        durationMs: task.result?.duration ?? 0,
        errorMessage: task.result?.errors?.[0]?.message,
      });
      return;
    }

    for (const child of task.tasks ?? []) {
      this.#walk(child, fullName);
    }
  }

  summary() {
    const by: Record<string, number> = {};
    for (const c of this.cases) by[c.outcome] = (by[c.outcome] ?? 0) + 1;
    return {
      total: this.cases.length,
      byOutcome: by,
      cases: this.cases,
    };
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

async function handleRunVitest(body: { n?: number; testPath?: string }) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY is not set" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const n = body.n ?? 10;
  process.env.AGENT_OBSERVABILITY_GENERATED_N = String(n);

  const testPath = body.testPath ?? GENERATED_TEST;
  const reporter = new JsonReporter();

  // startVitest returns a Vitest instance when it can fully start, or
  // undefined if the config itself is missing (rare). We run in `test` mode
  // with `watch: false` so the process exits naturally.
  const vitest = await startVitest(
    "test",
    [testPath],
    { watch: false, run: true, reporters: [reporter as any] },
  );

  if (!vitest) {
    return new Response(
      JSON.stringify({ error: "vitest failed to start" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  // When run: true, startVitest runs to completion before resolving. But
  // some versions queue the run async — awaiting close() is the documented
  // way to ensure the run is fully drained.
  await vitest.close();

  const passed = reporter.cases.every((c) => c.outcome === "passed");
  return Response.json({
    passed,
    ...reporter.summary(),
  });
}

async function handleRunScenarios(body: { n?: number }) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY is not set" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const n = body.n ?? 10;

  // Dynamic import so the top-level await in vitest_generated_agent.ts
  // (which hits OpenAI) only runs when the endpoint is actually invoked.
  process.env.AGENT_OBSERVABILITY_GENERATED_N = String(n);

  const mod = await import(GENERATED_TEST);
  const { summarize } = await import("./scenarioRunner.js");
  const results = await mod.runAll();
  return Response.json(summarize(results));
}

const port = Number(process.env.PORT ?? "8080");

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      n?: number;
      testPath?: string;
    };

    if (url.pathname === "/run/vitest") return handleRunVitest(body);
    if (url.pathname === "/run/scenarios") return handleRunScenarios(body);
    return new Response("not found", { status: 404 });
  },
});

console.log(`[bun-runner] listening on http://127.0.0.1:${port}`);
console.log(`  POST /run/vitest     — run vitest in-process on ${GENERATED_TEST}`);
console.log(`  POST /run/scenarios  — run scenarios directly (no vitest framing)`);
