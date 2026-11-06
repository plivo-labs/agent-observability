import { expect, mock, test } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);
const { MockJev } = await import("../src/jev/mock.js");
const { MockLLM } = await import("../src/llm/index.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
const { runValidation, summarizeValidation, summarizeRepeats, DatasetSchema } = await import("../scripts/lib/eval-validation.js");

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
import type { ValidationDataset, ValidationRun } from "../scripts/lib/eval-validation.js";
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


type Verdict = "pass" | "fail" | "unknown" | "absent";
function syntheticPair(expected: Verdict[], baseline: Verdict[], candidate: Verdict[]) {
  const d = structuredClone(dataset);
  d.cases[0]!.expected = expected.map((verdict, i) => ({ judgeName: "j", tag: String(i), verdict }));
  const makeRun = (verdicts: Verdict[]): ValidationRun => ({
    schemaVersion: 1, datasetFingerprint: fingerprint(d), revision: "test", settings: {}, startedAt: "test",
    cases: [{ id: "one", status: "completed", durationMs: 1,
      usage: { jevRequests: 0, llmCalls: 0, jevInputTokens: 0, jevOutputTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      rows: verdicts.flatMap((verdict, i) => verdict === "absent" ? [] : [{
        judgeName: "j", tag: String(i), passed: verdict === "pass", verdictText: verdict, reasoning: "", raw: {},
      }]),
    }],
  });
  return { dataset: d, baseline: makeRun(baseline), candidate: makeRun(candidate) };
}

test("fail precision and recall include Wilson 95% intervals and unavailable outcomes", () => {
  const pair = syntheticPair(["fail", "fail", "pass", "fail"], ["fail", "unknown", "fail", "absent"], []);
  const report = summarizeValidation(pair.dataset, pair.baseline);
  expect(report.rates.j!.failPrecision).toBe(0.5);
  expect(report.rates.j!.failRecall).toBeCloseTo(1 / 3, 10);
  expect(report.rates.j!.failPrecisionInterval95!.lower).toBeCloseTo(0.0945312, 6);
  expect(report.rates.j!.failPrecisionInterval95!.upper).toBeCloseTo(0.9054688, 6);
  expect(report.rates.j!.failRecallInterval95!.lower).toBeCloseTo(0.0614919, 6);
  expect(report.rates.j!.failRecallInterval95!.upper).toBeCloseTo(0.7923404, 6);
  expect(report.rates.j!.unknownAbsentShare).toBe(0.5);
  expect(report.outcomes).toEqual([
    { caseId: "one", judgeName: "j", tag: "0", expected: "fail", actual: "fail" },
    { caseId: "one", judgeName: "j", tag: "1", expected: "fail", actual: "unknown" },
    { caseId: "one", judgeName: "j", tag: "2", expected: "pass", actual: "fail" },
    { caseId: "one", judgeName: "j", tag: "3", expected: "fail", actual: "absent" },
  ]);
});

async function scoreOffline(d: ValidationDataset, run: ValidationRun, baseline?: unknown, flags: readonly string[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-validation-"));
  try {
    await writeFile(path.join(dir, "dataset.json"), JSON.stringify(d));
    await writeFile(path.join(dir, "run.json"), JSON.stringify(run));
    if (baseline !== undefined) await writeFile(path.join(dir, "baseline.json"), JSON.stringify(baseline));
    const cli = Bun.spawn([process.execPath, "scripts/eval-validation.ts",
      "--dataset", path.join(dir, "dataset.json"), "--results", path.join(dir, "run.json"), "--out", path.join(dir, "report"),
      ...(baseline === undefined ? [] : ["--baseline", path.join(dir, "baseline.json")]), ...flags,
    ], { env: { PATH: process.env.PATH, SIM_PERSIST: "false", JUDGES_FROM_DB: "off" }, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([cli.exited, new Response(cli.stderr).text(), new Response(cli.stdout).text()]);
    const report = await readFile(path.join(dir, "report", "report.json"), "utf8").then(JSON.parse).catch(() => null);
    return { code, stderr, report };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test.each([
  { fixed: 0, broke: 5, pValue: 0.0625, code: 0 },
  { fixed: 0, broke: 6, pValue: 0.03125, code: 1 },
  { fixed: 1, broke: 7, pValue: 0.0703125, code: 0 },
  { fixed: 1, broke: 8, pValue: 0.0390625, code: 1 },
  { fixed: 6, broke: 0, pValue: 0.03125, code: 0 },
  { fixed: 0, broke: 0, pValue: 1, code: 0 },
  { fixed: 600, broke: 600, pValue: 1, code: 0 },
  { fixed: 600, broke: 601, pValue: 1, code: 0 },
])("paired gate: $fixed fixed / $broke broke yields p=$pValue and exit $code", async ({ fixed, broke, pValue, code }) => {
  const pair = syntheticPair(
    Array(fixed + broke + 1).fill("pass"),
    [...Array(fixed).fill("fail"), ...Array(broke + 1).fill("pass")],
    [...Array(fixed).fill("pass"), ...Array(broke).fill("fail"), "pass"],
  );
  const baseline = summarizeValidation(pair.dataset, pair.baseline);
  baseline.outcomes.reverse();
  const result = await scoreOffline(pair.dataset, pair.candidate, baseline);
  expect(result.stderr).not.toContain("Error");
  expect(result.code).toBe(code);
  expect(result.report.comparison.perJudge.j.fixed).toBe(fixed);
  expect(result.report.comparison.perJudge.j.broke).toBe(broke);
  expect(result.report.comparison.perJudge.j.pValue).toBeCloseTo(pValue, 10);
});

test.each(["unknown", "absent"] as const)("coverage gate catches an all-%s candidate independently of correctness", async verdict => {
  const pair = syntheticPair(Array(100).fill("fail"), Array(100).fill("pass"), Array(100).fill(verdict));
  const result = await scoreOffline(pair.dataset, pair.candidate, summarizeValidation(pair.dataset, pair.baseline));
  expect(result.code).toBe(1);
  expect(result.report.comparison.perJudge.j).toMatchObject({ fixed: 0, broke: 0, pValue: 1, coverageRegression: true, unknownAbsentIncrease: 1 });
});

test.each([
  { missing: 2, flags: [], code: 0 },
  { missing: 3, flags: [], code: 1 },
  { missing: 3, flags: ["--unknown-margin", "0.03"], code: 0 },
  { missing: 1, flags: ["--unknown-margin", "0"], code: 1 },
])("coverage margin: $missing missing with $flags exits $code", async ({ missing, flags, code }) => {
  const pair = syntheticPair(Array(100).fill("fail"), Array(100).fill("pass"), [...Array(missing).fill("absent"), ...Array(100 - missing).fill("pass")]);
  const result = await scoreOffline(pair.dataset, pair.candidate, summarizeValidation(pair.dataset, pair.baseline), flags);
  expect(result.stderr).not.toContain("Error");
  expect(result.code).toBe(code);
  expect(result.report.comparison.perJudge.j.unknownAbsentIncrease).toBe(missing / 100);
});


test.each(["datasetFingerprint", "labelRevision"] as const)("CLI refuses a different baseline %s with exit 2", async field => {
  const pair = syntheticPair(["pass"], ["pass"], ["pass"]);
  const baseline = { ...summarizeValidation(pair.dataset, pair.baseline), [field]: "different" };
  const result = await scoreOffline(pair.dataset, pair.candidate, baseline);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(field === "datasetFingerprint" ? "fingerprint" : "label revision");
  expect(result.report).toBeNull();
});

test("CLI refuses a baseline with no outcomes before judging anything", async () => {
  const pair = syntheticPair(["pass"], ["pass"], ["pass"]);
  const { outcomes: _dropped, ...baseline } = summarizeValidation(pair.dataset, pair.baseline);
  const result = await scoreOffline(pair.dataset, pair.candidate, baseline);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("outcomes");
  expect(result.report).toBeNull();
});

test.each(["missing", "duplicate", "wrong-key", "wrong-label"])("paired comparison rejects %s outcomes with exit 2", async defect => {
  const pair = syntheticPair(["pass", "fail"], ["pass", "fail"], ["pass", "fail"]);
  const baseline = summarizeValidation(pair.dataset, pair.baseline);
  if (defect === "missing") baseline.outcomes.pop();
  if (defect === "duplicate") baseline.outcomes[1] = baseline.outcomes[0]!;
  if (defect === "wrong-key") baseline.outcomes[0]!.caseId = "different";
  if (defect === "wrong-label") baseline.outcomes[0]!.expected = "unknown";
  const result = await scoreOffline(pair.dataset, pair.candidate, baseline);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("Error");
});

test("repeat summary measures adjacent verdict flips, including unknown and absent, per judge", () => {
  const pair = syntheticPair(["pass", "pass", "pass"], ["pass", "unknown", "absent"], ["fail", "absent", "absent"]);
  pair.dataset.cases[0]!.expected.push({ judgeName: "stable", tag: null, verdict: "absent" });
  pair.baseline.datasetFingerprint = pair.candidate.datasetFingerprint = fingerprint(pair.dataset);
  const first = summarizeValidation(pair.dataset, pair.baseline), second = summarizeValidation(pair.dataset, pair.candidate);
  second.outcomes.reverse();
  expect(summarizeRepeats([first, second, second])).toEqual({
    runs: 3, perJudge: { j: { comparisons: 6, flips: 2, flipRate: 1 / 3 }, stable: { comparisons: 2, flips: 0, flipRate: 0 } },
  });
  expect(() => summarizeRepeats([first])).toThrow("at least two");
});

test("offline CLI refuses --repeat instead of treating rescoring as live judging", async () => {
  const pair = syntheticPair(["pass"], ["pass"], ["pass"]);
  const result = await scoreOffline(pair.dataset, pair.candidate, undefined, ["--repeat", "2"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--repeat requires --live");
  expect(result.report).toBeNull();
});

test.each([false, true])("live CLI repeats judging and gates every trial with baseline=%s", async withBaseline => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-validation-"));
  try {
    const d = structuredClone(dataset);
    d.cases = Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(d.cases[0]!), id: `case-${i}` }));
    await writeFile(path.join(dir, "dataset.json"), JSON.stringify(d));
    if (withBaseline) {
      const run = await runValidation(d, { llm: new MockLLM([args => defaultJudgeResponder(args.system)!]), revision: "test", settings: {} });
      await writeFile(path.join(dir, "baseline.json"), JSON.stringify(summarizeValidation(d, run)));
    }
    const preload = path.join(dir, "provider.ts");
    await writeFile(preload, `
      import { mock } from "bun:test";
      import { defaultJudgeResponder } from ${JSON.stringify(path.resolve("tests/fixtures/default-judge-responder.ts"))};
      let loops = 0;
      mock.module(${JSON.stringify(path.resolve("src/llm/providers/openai.ts"))}, () => ({ openaiProvider: {
        name: "mock", async complete(args) {
          let content = defaultJudgeResponder(args.system);
          if (args.jsonSchema?.name === "eval_loop" && ++loops > 6) content = JSON.stringify({ loop_detected: true, score: 0, reason: "repeated", technical_reason: "" });
          return { text: content, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
      } }));
    `);
    const cli = Bun.spawn([process.execPath, "--preload", preload, "scripts/eval-validation.ts",
      "--dataset", path.join(dir, "dataset.json"), "--live", "--backend", "llm", "--repeat", "3", "--out", path.join(dir, "report"),
      ...(withBaseline ? ["--baseline", path.join(dir, "baseline.json")] : []),
    ], { env: { PATH: process.env.PATH, SIM_PERSIST: "false", JUDGES_FROM_DB: "off", LLM_PROVIDER: "openai", OPENAI_API_KEY: "test-key", JUDGE_MODEL: "test-model" }, stdout: "pipe", stderr: "pipe" });
    const [code, stderr, stdout] = await Promise.all([cli.exited, new Response(cli.stderr).text(), new Response(cli.stdout).text()]);
    expect(stderr).not.toContain("Error");
    expect(code, stdout + stderr).toBe(withBaseline ? 1 : 0);
    const report = JSON.parse(await readFile(path.join(dir, "report", "report.json"), "utf8"));
    expect(report.repeat).toMatchObject({ runs: 3, perJudge: { node_loop: { comparisons: 12, flips: 6, flipRate: 0.5 }, voicemail_detection: { flips: 0, flipRate: 0 } } });
    const secondRun = JSON.parse(await readFile(path.join(dir, "report", "run-2.json"), "utf8"));
    expect(secondRun.cases[0].rows.find((row: { judgeName: string }) => row.judgeName === "node_loop").passed).toBe(false);
    const thirdReport = JSON.parse(await readFile(path.join(dir, "report", "report-3.json"), "utf8"));
    expect(thirdReport.perJudge.node_loop.falseFailures).toBe(6);
    if (withBaseline) {
      expect(report.comparison.exitCode).toBe(0);
      expect(thirdReport.comparison.perJudge.node_loop).toMatchObject({ broke: 6, fixed: 0, regression: true });
      expect(thirdReport.comparison.perJudge.node_loop.pValue).toBeCloseTo(0.03125, 10);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("undefined fail precision and recall have null intervals; zero and perfect rates remain bounded", () => {
  const pair = syntheticPair(["pass"], ["pass"], ["fail"]);
  const correct = summarizeValidation(pair.dataset, pair.baseline).rates.j!;
  expect(correct.failPrecision).toBeNull();
  expect(correct.failPrecisionInterval95).toBeNull();
  expect(correct.failRecall).toBeNull();
  expect(correct.failRecallInterval95).toBeNull();
  const wrong = summarizeValidation(pair.dataset, pair.candidate).rates.j!;
  expect(wrong.failPrecision).toBe(0);
  expect(wrong.failPrecisionInterval95!.lower).toBe(0);
  expect(wrong.failPrecisionInterval95!.upper).toBeCloseTo(0.7934507, 6);
  const failed = syntheticPair(["fail"], ["fail"], []);
  const perfect = summarizeValidation(failed.dataset, failed.baseline).rates.j!;
  expect(perfect.failRecall).toBe(1);
  expect(perfect.failRecallInterval95!.lower).toBeCloseTo(0.2065493, 6);
  expect(perfect.failRecallInterval95!.upper).toBe(1);
});

test.each(["correctness", "coverage"])("a per-judge %s regression cannot be masked by another judge", async metric => {
  const pair = syntheticPair(["pass", "pass"], ["pass", "fail"], ["fail", "pass"]);
  pair.dataset.cases[0]!.expected[1]!.judgeName = "other";
  pair.baseline.cases[0]!.rows[1]!.judgeName = pair.candidate.cases[0]!.rows[1]!.judgeName = "other";
  if (metric === "coverage") {
    pair.dataset.cases[0]!.expected[0]!.verdict = "fail";
    pair.candidate.cases[0]!.rows[0]!.verdictText = "unknown";
    pair.baseline.cases[0]!.rows[1]!.verdictText = "unknown";
  }
  for (let i = 1; i < 6; i++) {
    pair.dataset.cases.push({ ...structuredClone(pair.dataset.cases[0]!), id: `case-${i}` });
    pair.baseline.cases.push({ ...structuredClone(pair.baseline.cases[0]!), id: `case-${i}` });
    pair.candidate.cases.push({ ...structuredClone(pair.candidate.cases[0]!), id: `case-${i}` });
  }
  pair.baseline.datasetFingerprint = pair.candidate.datasetFingerprint = fingerprint(pair.dataset);
  pair.candidate.cases.reverse();
  const result = await scoreOffline(pair.dataset, pair.candidate, summarizeValidation(pair.dataset, pair.baseline));
  expect(result.code).toBe(1);
  expect(result.report.comparison.perJudge.j[metric === "correctness" ? "regression" : "coverageRegression"]).toBe(true);
  expect(result.report.comparison.perJudge.other).toMatchObject({ fixed: 6, broke: 0, regression: false, coverageRegression: false });
});
