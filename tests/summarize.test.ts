import { describe, test, expect } from "bun:test";
import { computeCaseMetrics, summarize } from "../src/evals/summarize.js";

function mkCase(overrides: any) {
  return {
    case_id: "c",
    name: "t",
    status: "passed",
    events: [],
    judgments: [],
    ...overrides,
  };
}

describe("summarize()", () => {
  test("totals match input length regardless of rule", () => {
    const cases = [
      mkCase({ status: "passed" }),
      mkCase({ status: "failed" }),
      mkCase({ status: "errored" }),
      mkCase({ status: "skipped" }),
    ] as any;
    const r = summarize(cases);
    expect(r.total).toBe(4);
    expect(r.errored).toBe(1);
    expect(r.skipped).toBe(1);
    // passed + failed + errored + skipped === total
    expect(r.passed + r.failed + r.errored + r.skipped).toBe(r.total);
  });

  test("empty input returns all zeros", () => {
    const r = summarize([]);
    expect(r).toEqual({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 });
  });

  test("only errored/skipped cases are counted as such", () => {
    const cases = [
      mkCase({ status: "errored" }),
      mkCase({ status: "errored" }),
      mkCase({ status: "skipped" }),
    ] as any;
    const r = summarize(cases);
    expect(r.errored).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
  });
});

describe("computeCaseMetrics()", () => {
  test("aggregates tokens and estimates known model cost", () => {
    const metrics = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          llm_prompt_tokens: 1_000,
          llm_completion_tokens: 250,
          llm_metadata: { model_provider: "openai", model_name: "gpt-4o-mini" },
        },
      },
      {
        type: "usage",
        provider: "openai",
        model: "gpt-4.1-mini",
        input_tokens: 500,
        output_tokens: 100,
      },
    ]);

    expect(metrics.prompt_tokens).toBe(1_500);
    expect(metrics.completion_tokens).toBe(350);
    expect(metrics.total_tokens).toBe(1_850);
    expect(metrics.estimated_cost_usd).toBe(0.00066);
  });

  test("keeps cost unknown when provider or model is not priced", () => {
    const metrics = computeCaseMetrics([
      {
        type: "message",
        role: "assistant",
        metrics: {
          llm_prompt_tokens: 100,
          llm_completion_tokens: 25,
          llm_metadata: { model_provider: "local", model_name: "custom" },
        },
      },
    ]);

    expect(metrics.total_tokens).toBe(125);
    expect(metrics.estimated_cost_usd).toBeNull();
  });
});
