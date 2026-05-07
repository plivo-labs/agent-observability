import { describe, test, expect, beforeEach, vi } from "vitest";
import { judges } from "../src/judges/index.js";
import { HALLUCINATION_RUBRIC, ADHERENCE_RUBRIC } from "../src/judges/rubrics.js";
import { buildPrompt } from "../src/judges/prompt.js";
import { reset, peekPending } from "../src/collector.js";

beforeEach(() => reset());

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLLM(response: string) {
  return { evaluate: vi.fn(async () => response) };
}

const BASE_INPUT = { response: "The capital of France is Paris." };

// ── Single-criterion: hallucination ──────────────────────────────────────────

describe("judges.hallucination", () => {
  test("records one judgment and returns a CriterionResult", async () => {
    const llm = makeLLM(
      JSON.stringify({ hallucination: { score: 0.9, reason: "all good" } }),
    );
    const result = await judges.hallucination(BASE_INPUT, llm);
    expect(result).toMatchObject({
      name: "hallucination",
      score: 0.9,
      reason: "all good",
      verdict: "pass",
    });
    expect(peekPending().judgments).toHaveLength(1);
    expect(peekPending().judgments[0]).toMatchObject({
      intent: "hallucination",
      verdict: "pass",
    });
  });
});

// ── Multi-criterion: single LLM call, two judgments ─────────────────────────

describe("judges.evaluate", () => {
  test("makes ONE LLM call and records TWO judgments", async () => {
    const llm = makeLLM(
      JSON.stringify({
        hallucination: { score: 0.8, reason: "ok" },
        adherence: { score: 0.9, reason: "follows instructions" },
      }),
    );
    const results = await judges.evaluate({
      criteria: ["hallucination", "adherence"],
      input: BASE_INPUT,
      llm,
    });
    expect(llm.evaluate).toHaveBeenCalledTimes(1);
    expect(Object.keys(results)).toHaveLength(2);
    expect(peekPending().judgments).toHaveLength(2);
    const intents = peekPending().judgments.map((j) => j.intent);
    expect(intents).toContain("hallucination");
    expect(intents).toContain("adherence");
  });
});

// ── Threshold logic ───────────────────────────────────────────────────────────

describe("threshold logic", () => {
  test("score 0.6 with default threshold 0.7 → verdict fail", async () => {
    const llm = makeLLM(
      JSON.stringify({ hallucination: { score: 0.6, reason: "minor issue" } }),
    );
    const result = await judges.hallucination(BASE_INPUT, llm);
    expect(result?.verdict).toBe("fail");
  });

  test("score 0.7 with default threshold 0.7 → verdict pass", async () => {
    const llm = makeLLM(
      JSON.stringify({ hallucination: { score: 0.7, reason: "borderline" } }),
    );
    const result = await judges.hallucination(BASE_INPUT, llm);
    expect(result?.verdict).toBe("pass");
  });

  test("score 0.9 with custom threshold 0.95 → verdict fail", async () => {
    const llm = makeLLM(
      JSON.stringify({ hallucination: { score: 0.9, reason: "almost there" } }),
    );
    const result = await judges.hallucination(BASE_INPUT, llm, {
      threshold: 0.95,
    });
    expect(result?.verdict).toBe("fail");
  });
});

// ── JSON parse failure ────────────────────────────────────────────────────────

describe("parse failure", () => {
  test("records one judge_failed judgment and returns {}", async () => {
    const llm = makeLLM("this is not json at all ~~~");
    const results = await judges.evaluate({
      criteria: ["hallucination"],
      input: BASE_INPUT,
      llm,
    });
    expect(results).toEqual({});
    expect(peekPending().judgments).toHaveLength(1);
    expect(peekPending().judgments[0]).toMatchObject({
      intent: "judge_failed",
      verdict: "fail",
    });
  });
});

// ── Prompt content ────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  test("contains criteria and steps for hallucination rubric", () => {
    const prompt = buildPrompt([HALLUCINATION_RUBRIC], BASE_INPUT);
    expect(prompt).toContain(HALLUCINATION_RUBRIC.criteria);
    for (const step of HALLUCINATION_RUBRIC.steps) {
      expect(prompt).toContain(step);
    }
  });

  test("contains criteria and steps for adherence rubric", () => {
    const prompt = buildPrompt([ADHERENCE_RUBRIC], BASE_INPUT);
    expect(prompt).toContain(ADHERENCE_RUBRIC.criteria);
    for (const step of ADHERENCE_RUBRIC.steps) {
      expect(prompt).toContain(step);
    }
  });

  test("omits empty slots (no context, no systemPrompt)", () => {
    const prompt = buildPrompt([HALLUCINATION_RUBRIC], BASE_INPUT);
    expect(prompt).not.toContain("<context>\n");
    expect(prompt).not.toContain("<system_prompt>\n");
  });

  test("includes context when provided", () => {
    const prompt = buildPrompt([HALLUCINATION_RUBRIC], {
      ...BASE_INPUT,
      context: "Some grounding context.",
    });
    expect(prompt).toContain("<context>");
    expect(prompt).toContain("Some grounding context.");
  });

  test("includes systemPrompt when provided", () => {
    const prompt = buildPrompt([HALLUCINATION_RUBRIC], {
      ...BASE_INPUT,
      systemPrompt: "You are a helpful assistant.",
    });
    expect(prompt).toContain("<system_prompt>");
    expect(prompt).toContain("You are a helpful assistant.");
  });

  test("includes both rubrics when two passed", () => {
    const prompt = buildPrompt(
      [HALLUCINATION_RUBRIC, ADHERENCE_RUBRIC],
      BASE_INPUT,
    );
    expect(prompt).toContain('name="hallucination"');
    expect(prompt).toContain('name="adherence"');
  });
});

// ── Custom rubric ─────────────────────────────────────────────────────────────

describe("judges.custom", () => {
  test("evaluates a user-defined rubric", async () => {
    const myRubric = {
      name: "tone",
      criteria: "Is the tone professional?",
      steps: ["Check for informal language.", "Score 1.0 if professional."],
    };
    const llm = makeLLM(
      JSON.stringify({ tone: { score: 1.0, reason: "very professional" } }),
    );
    const result = await judges.custom({ rubric: myRubric, input: BASE_INPUT, llm });
    expect(result).toMatchObject({
      name: "tone",
      score: 1.0,
      verdict: "pass",
    });
    expect(peekPending().judgments[0]).toMatchObject({
      intent: "tone",
      verdict: "pass",
    });
  });
});
