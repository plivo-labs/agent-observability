import { describe, test, expect, mock, beforeEach } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { recordJudgedSession } = await import("../src/evals-engine/verdict-metrics.js");
const { registry } = await import("../src/prometheus.js");
type Row = import("../src/evals-engine/fan-out-rows.js").ExternalEvalRow;

const row = (judgeName: string, passed: boolean, over: Partial<Row> = {}): Row => ({
  judgeName, tag: null, passed, reasoning: "r", raw: {}, ...over,
});
const sentimentRow = (sentiment: string) => row("user_sentiment", true, { raw: { sentiment } });

async function values(name: string): Promise<Array<{ labels: Record<string, string | number>; value: number }>> {
  const metric = registry.getSingleMetric(name);
  return metric ? ((await metric.get()).values as any) : [];
}
async function count(name: string, labels: Record<string, string> = {}): Promise<number> {
  return (await values(name))
    .filter((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))
    .reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => registry.resetMetrics());

describe("recordJudgedSession", () => {
  test("one verdict per (session, judge): a node judge failing on any node is one fail", async () => {
    recordJudgedSession([
      row("hallucination", true, { tag: "n1" }),
      row("hallucination", false, { tag: "n2" }),
      row("node_loop", true, { tag: "n1" }),
      row("node_loop", true, { tag: "n2" }),
      row("voicemail_detection", false),
    ]);
    expect(await count("ao_judge_verdicts_total", { judge: "hallucination", verdict: "fail" })).toBe(1);
    expect(await count("ao_judge_verdicts_total", { judge: "hallucination", verdict: "pass" })).toBe(0);
    expect(await count("ao_judge_verdicts_total", { judge: "node_loop", verdict: "pass" })).toBe(1);
    expect(await count("ao_judge_verdicts_total", { judge: "voicemail_detection", verdict: "fail" })).toBe(1);
    expect(await count("ao_sessions_judged_total")).toBe(1);
    expect(await count("ao_judge_verdicts_total", { region: "unknown" })).toBe(3);
  });

  test("a session failing several quality judges is one quality-failed session", async () => {
    recordJudgedSession([
      row("hallucination", false),
      row("instructions_adherence", false),
      row("node_loop", false),
    ]);
    expect(await count("ao_sessions_quality_failed_total")).toBe(1);
  });

  test("a failing detection judge alone does not fail quality", async () => {
    recordJudgedSession([row("voicemail_detection", false), row("hallucination", true)]);
    expect(await count("ao_sessions_judged_total")).toBe(1);
    expect(await count("ao_sessions_quality_failed_total")).toBe(0);
  });

  test("custom judges collapse to judge=other; unknown verdicts are not counted", async () => {
    recordJudgedSession([
      row("acme_politeness", false),
      row("acme_upsell", true),
      row("acme_refund", false, { verdictText: "unknown" }),
    ]);
    expect(await count("ao_judge_verdicts_total", { judge: "other", verdict: "fail" })).toBe(1);
    expect(await count("ao_judge_verdicts_total", { judge: "other", verdict: "pass" })).toBe(1);
    expect((await values("ao_judge_verdicts_total")).map((v) => v.labels.judge)).toEqual(["other", "other"]);
  });

  test("sentiment is lowercased; values outside the judge's enum become other", async () => {
    recordJudgedSession([sentimentRow("Negative")]);
    recordJudgedSession([sentimentRow("furious")]);
    recordJudgedSession([row("hallucination", true)]);
    expect(await count("ao_user_sentiment_total", { sentiment: "negative" })).toBe(1);
    expect(await count("ao_user_sentiment_total", { sentiment: "other" })).toBe(1);
    expect(await count("ao_user_sentiment_total")).toBe(2);
  });

  test("never throws on a malformed row", () => {
    expect(() => recordJudgedSession([{ judgeName: "user_sentiment", passed: true } as any])).not.toThrow();
  });
});
