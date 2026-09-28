import { expect, mock, test } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);
const { MockJev } = await import("../src/jev/mock.js");
const { MockLLM } = await import("../src/llm/index.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
const { runValidation, summarizeValidation, DatasetSchema } = await import("../scripts/lib/eval-validation.js");

const dataset = DatasetSchema.parse({
  schemaVersion: 1, datasetId: "synthetic-orders", labelRevision: "r1", split: "synthetic", reviewer: "fixture-author",
  cases: [{ id: "one", groupId: "flow-one", config: { flow_name: "orders", nodes: [{ ref: "A", name: "orders", instructions: "Ask for order id." }] },
    events: [
      { type: "conversation_item_added", node_ref: "A", item: { type: "message", role: "assistant", content: "What is your order id?" } },
      { type: "conversation_item_added", node_ref: "A", item: { type: "message", role: "user", content: "42" } },
    ],
    expected: [{ judgeName: "node_loop", tag: "A", verdict: "pass" }, { judgeName: "voicemail_detection", tag: null, verdict: "pass" }],
  }],
});

test("validation runs ingest through final fan-out and preserves unlabelled rows", async () => {
  const run = await runValidation(dataset, {
    jev: new MockJev([{}], 0.01), llm: new MockLLM([a => defaultJudgeResponder(a.system)!]),
    revision: "test", settings: { model: "mock" },
  });
  expect(run.cases[0]!.rows.find(r => r.judgeName === "node_loop")?.tag).toBe("A");
  const report = summarizeValidation(dataset, run);
  expect(report.mismatches).toHaveLength(0);
  expect(report.unlabelledRows).toBeGreaterThan(0);
  expect(report.perJudge.node_loop!.confusion["pass->pass"]).toBe(1);
  expect(run.cases[0]!.usage.jevRequests).toBeGreaterThan(0);
  expect(run.cases[0]!.usage.llmCalls).toBeGreaterThan(0);
  expect(report.accuracyClaimAllowed).toBe(false);
});

test("missing, unknown, false passes, and false failures stay distinct", async () => {
  const run = await runValidation(dataset, { jev: new MockJev([{}], 0.01), llm: new MockLLM([a => defaultJudgeResponder(a.system)!]), revision: "test", settings: {} });
  run.cases[0]!.rows = [{ judgeName: "node_loop", tag: "A", passed: false, reasoning: "reviewed", raw: { backend: "llm" } }];
  const report = summarizeValidation(dataset, run);
  expect(report.perJudge.node_loop!.falseFailures).toBe(1);
  expect(report.perJudge.voicemail_detection!.missing).toBe(1);
  expect(report.mismatches).toHaveLength(2);
  const changed = structuredClone(dataset);
  changed.labelRevision = "r2";
  expect(() => summarizeValidation(changed, run)).toThrow("dataset fingerprint");
});

test("duplicate case IDs or judge/node labels are rejected", () => {
  expect(() => DatasetSchema.parse({ ...dataset, cases: [...dataset.cases, dataset.cases[0]] })).toThrow();
  const bad = structuredClone(dataset);
  bad.cases[0]!.expected.push(bad.cases[0]!.expected[0]!);
  expect(() => DatasetSchema.parse(bad)).toThrow();
});

test("false passes and unknown results do not inflate auto-pass accuracy", () => {
  const d = structuredClone(dataset);
  d.cases[0]!.expected = [
    { judgeName: "j", tag: "a", verdict: "fail" },
    { judgeName: "j", tag: "b", verdict: "fail" },
    { judgeName: "j", tag: "c", verdict: "pass" },
    { judgeName: "j", tag: "d", verdict: "unknown" },
  ];
  const rows = [
    { judgeName: "j", tag: "a", passed: true, reasoning: "", raw: { backend: "jev" } },
    { judgeName: "j", tag: "b", passed: false, verdictText: "unknown", reasoning: "", raw: { backend: "llm" } },
    { judgeName: "j", tag: "c", passed: true, reasoning: "", raw: { backend: "jev" } },
    { judgeName: "j", tag: "d", passed: false, verdictText: "unknown", reasoning: "", raw: { backend: "llm" } },
  ];
  const run = { schemaVersion: 1 as const, datasetFingerprint: fingerprint(d), revision: "test", settings: {}, startedAt: "test",
    cases: [{ id: "one", status: "completed" as const, durationMs: 1, usage: { jevRequests: 0, llmCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 }, rows }],
  };
  const report = summarizeValidation(d, run);
  expect(report.perJudge.j!.falsePasses).toBe(1);
  expect(report.perJudge.j!.unknown).toBe(2);
  expect(report.rates.j!.autoPassError).toBe(0.5);
  expect(report.rates.j!.autoPassCoverage).toBe(2 / 3);
  expect(report.rates.j!.falsePassRate).toBe(0.5);
  run.cases[0]!.rows = [];
  expect(summarizeValidation(d, run).rates.j!.autoPassError).toBeNull();
});

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const { fingerprint } = await import("../scripts/lib/eval-validation.js");

test("offline CLI scores saved output without model credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-validation-"));
  try {
    const run = await runValidation(dataset, { jev: new MockJev([{}], 0.01), llm: new MockLLM([a => defaultJudgeResponder(a.system)!]), revision: "test", settings: {} });
    await writeFile(path.join(dir, "dataset.json"), JSON.stringify(dataset));
    await writeFile(path.join(dir, "run.json"), JSON.stringify(run));
    const cli = Bun.spawn([process.execPath, "scripts/eval-validation.ts", "--dataset", path.join(dir, "dataset.json"), "--results", path.join(dir, "run.json"), "--out", path.join(dir, "report")], {
      env: { PATH: process.env.PATH, SIM_PERSIST: "false", JUDGES_FROM_DB: "off" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([cli.exited, new Response(cli.stderr).text()]);
    expect(stderr).not.toContain("Error");
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(path.join(dir, "report", "report.json"), "utf8"));
    expect(report.mismatches).toHaveLength(0);
    expect(report.accuracyClaimAllowed).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("a failed session freezes partial usage and prevents overlapping later cases", async () => {
  const d = structuredClone(dataset);
  d.cases.push({ ...structuredClone(d.cases[0]!), id: "two" });
  let active = 0;
  const provider = new MockLLM([async args => {
    if (args.jsonSchema?.name === "eval_loop") throw new Error("429 rate limit");
    if (args.jsonSchema?.name === "eval_sentiment") {
      active++;
      await Bun.sleep(1600);
      active--;
    }
    return defaultJudgeResponder(args.system)!;
  }]);
  const run = await runValidation(d, { llm: provider, revision: "test", settings: {} });
  expect(run.cases.map(c => c.status)).toEqual(["failed", "not_run"]);
  const snapshot = JSON.stringify(run);
  await Bun.sleep(500);
  expect(active).toBe(0);
  expect(JSON.stringify(run)).toBe(snapshot);
  const report = summarizeValidation(d, run);
  expect(report.latencyMs.samples).toBe(0);
  expect(report.latencyMs.p50).toBeNull();
  expect(report.partialUsage).toHaveLength(1);
  expect(report.usage.llmCalls).toBe(0);
  expect(report.notRunSessions).toEqual(["two"]);
});
