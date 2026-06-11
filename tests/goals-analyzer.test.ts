/**
 * Unit tests for the goal-analyzer sweep: claim → load → judge (mock
 * LLM via ai/test) → write verdicts / mark errors. The db layer is
 * mocked (its semantics are covered by tests-integration/goals-db);
 * these tests pin the orchestration and the model-output contract.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";

const mockClaim = mock(() => Promise.resolve([] as string[]));
const mockLoad = mock(() =>
  Promise.resolve({ goals: [] as string[], chatHistory: null as unknown }),
);
const mockComplete = mock(() => Promise.resolve());
const mockError = mock(() => Promise.resolve());

mock.module("../src/goals/db.js", () => ({
  claimGoalSessions: mockClaim,
  loadGoalSession: mockLoad,
  completeGoalAnalysis: mockComplete,
  markGoalAnalysisError: mockError,
  MAX_ATTEMPTS: 3,
}));

const fakeConfig: Record<string, unknown> = {
  OPENAI_API_KEY: undefined,
  JUDGE_LLM_MODEL: undefined,
  OPENAI_MODEL: undefined,
  GOAL_ANALYZER: "inline",
};
mock.module("../src/config.js", () => ({
  config: fakeConfig,
  s3Enabled: false,
  basicAuthEnabled: false,
  liveKitAuthEnabled: false,
}));

const { runGoalSweepOnce, resolveJudgeModel } = await import("../src/goals/analyzer.js");

const CHAT = [
  { type: "message", role: "user", content: ["I want to cancel my subscription."] },
  { type: "message", role: "assistant", content: ["Done — cancelled."] },
];

function modelReturning(...payloads: unknown[]) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const payload = payloads[Math.min(call++, payloads.length - 1)];
      if (payload instanceof Error) throw payload;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      };
    },
  });
}

beforeEach(() => {
  mockClaim.mockClear();
  mockLoad.mockClear();
  mockComplete.mockClear();
  mockError.mockClear();
  fakeConfig.OPENAI_API_KEY = undefined;
  fakeConfig.JUDGE_LLM_MODEL = undefined;
  fakeConfig.OPENAI_MODEL = undefined;
});

describe("resolveJudgeModel", () => {
  test("precedence: JUDGE_LLM_MODEL → OPENAI_MODEL → gpt-4.1-mini", () => {
    expect(resolveJudgeModel()).toBe("gpt-4.1-mini");
    fakeConfig.OPENAI_MODEL = "gpt-4o";
    expect(resolveJudgeModel()).toBe("gpt-4o");
    fakeConfig.JUDGE_LLM_MODEL = "gpt-5";
    expect(resolveJudgeModel()).toBe("gpt-5");
  });
});

describe("runGoalSweepOnce", () => {
  test("is a no-op without an API key or injected model", async () => {
    await runGoalSweepOnce();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test("judges each claimed session and writes one verdict per goal", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({
      goals: ["Resolve the issue", "Confirm identity"],
      chatHistory: CHAT,
    } as never);

    await runGoalSweepOnce({
      model: modelReturning({
        goals: [
          { met: true, reasoning: "Issue was resolved.", what_went_wrong: null },
          { met: false, reasoning: "Never asked.", what_went_wrong: "No identity check" },
        ],
      }),
    });

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [sessionId, verdicts] = mockComplete.mock.calls[0] as unknown as [string, unknown[]];
    expect(sessionId).toBe("s1");
    expect(verdicts).toEqual([
      { goal: "Resolve the issue", met: true, reasoning: "Issue was resolved.", whatWentWrong: null },
      {
        goal: "Confirm identity",
        met: false,
        reasoning: "Never asked.",
        whatWentWrong: "No identity check",
      },
    ]);
    expect(mockError).not.toHaveBeenCalled();
  });

  test("verdict-count mismatch marks an error and writes nothing", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({ goals: ["A", "B"], chatHistory: CHAT } as never);

    await runGoalSweepOnce({
      model: modelReturning({
        goals: [{ met: true, reasoning: "only one", what_went_wrong: null }],
      }),
    });

    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    const [, message] = mockError.mock.calls[0] as unknown as [string, string];
    expect(message).toContain("verdict");
  });

  test("a model failure marks that session and continues with the next", async () => {
    mockClaim.mockResolvedValueOnce(["s1", "s2"] as never);
    mockLoad
      .mockResolvedValueOnce({ goals: ["A"], chatHistory: CHAT } as never)
      .mockResolvedValueOnce({ goals: ["B"], chatHistory: CHAT } as never);

    await runGoalSweepOnce({
      model: modelReturning(new Error("rate limited"), {
        goals: [{ met: true, reasoning: "ok", what_went_wrong: null }],
      }),
    });

    expect(mockError).toHaveBeenCalledTimes(1);
    expect((mockError.mock.calls[0] as unknown as [string, string])[0]).toBe("s1");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect((mockComplete.mock.calls[0] as unknown as [string])[0]).toBe("s2");
  });

  test("a session with zero goals at analysis time is marked errored, not judged", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({ goals: [], chatHistory: CHAT } as never);

    await runGoalSweepOnce({
      model: modelReturning({ goals: [] }),
    });

    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});
