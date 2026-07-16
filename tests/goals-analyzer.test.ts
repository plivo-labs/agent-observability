/**
 * Unit tests for the goal-analyzer sweep: claim → load → judge (via the repo's
 * MockLLM through runGoalJudge/completeJSON) → write verdicts / mark errors.
 * The db layer is mocked (its semantics are covered by tests-integration/
 * goals-db); these tests pin the orchestration and the verdict contract —
 * including name-keyed reconciliation (order-independent) and the missing/empty
 * cases.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { MockLLM } from "../src/llm/mock.js";
import { TEST_JUDGE_CONFIG } from "./fixtures/judge-config.js";

const mockClaim = mock(() => Promise.resolve([] as string[]));
const mockLoad = mock(() =>
  Promise.resolve({ goals: [] as unknown, chatHistory: null as unknown }),
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

// completeJSON reads LLM_TIMEOUT_MS (AbortSignal.timeout) + LLM_PROVIDER; the
// injected MockLLM bypasses provider resolution and the key checks.
const fakeConfig: Record<string, unknown> = {
  ...TEST_JUDGE_CONFIG,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  GOAL_ANALYZER: "inline",
};
mock.module("../src/config.js", () => ({
  config: fakeConfig,
  s3Enabled: false,
  basicAuthEnabled: false,
  liveKitAuthEnabled: false,
  dbConfigured: false,
}));

const { runGoalSweepOnce } = await import("../src/goals/analyzer.js");

const CHAT = [
  { type: "message", role: "user", content: ["I want to cancel my subscription."] },
  { type: "message", role: "assistant", content: ["Done — cancelled."] },
];

/** A MockLLM returning the evals-engine goal-judge JSON shape. */
function judgeReturning(...verdicts: Array<{ goal_name: string; achieved: boolean; reason: string; technical_reason: string }>) {
  return new MockLLM([JSON.stringify({ goals: verdicts })]);
}

beforeEach(() => {
  mockClaim.mockClear();
  mockLoad.mockClear();
  mockComplete.mockClear();
  mockError.mockClear();
});

describe("runGoalSweepOnce", () => {
  test("is a no-op without a provider key or injected provider", async () => {
    await runGoalSweepOnce();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test("judges each claimed session and writes one verdict per goal", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({
      goals: [
        { name: "resolution", description: "Resolve the issue" },
        { name: "identity", description: "Confirm identity" },
      ],
      chatHistory: CHAT,
    } as never);

    await runGoalSweepOnce({
      provider: judgeReturning(
        { goal_name: "resolution", achieved: true, reason: "Issue was resolved.", technical_reason: "" },
        { goal_name: "identity", achieved: false, reason: "Never asked.", technical_reason: "No identity check" },
      ),
    });

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [sessionId, verdicts] = mockComplete.mock.calls[0] as unknown as [string, unknown[]];
    expect(sessionId).toBe("s1");
    expect(verdicts).toEqual([
      {
        name: "resolution",
        description: "Resolve the issue",
        met: true,
        reasoning: "Issue was resolved.",
        whatWentWrong: null,
      },
      {
        name: "identity",
        description: "Confirm identity",
        met: false,
        reasoning: "Never asked.",
        whatWentWrong: "No identity check",
      },
    ]);
    expect(mockError).not.toHaveBeenCalled();
  });

  test("verdicts are matched to goals BY NAME, not array position (G-1)", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({
      goals: [
        { name: "resolution", description: "Resolve the issue" },
        { name: "identity", description: "Confirm identity" },
      ],
      chatHistory: CHAT,
    } as never);

    // Model returns the verdicts in the REVERSE order — name-keyed
    // reconciliation must still attribute each to the right goal.
    await runGoalSweepOnce({
      provider: judgeReturning(
        { goal_name: "identity", achieved: false, reason: "Never asked.", technical_reason: "No identity check" },
        { goal_name: "resolution", achieved: true, reason: "Issue was resolved.", technical_reason: "" },
      ),
    });

    const [, verdicts] = mockComplete.mock.calls[0] as unknown as [string, Array<{ name: string; met: boolean }>];
    expect(verdicts[0]).toMatchObject({ name: "resolution", met: true });
    expect(verdicts[1]).toMatchObject({ name: "identity", met: false });
  });

  test("a goal the model skipped defaults to not-met (no hard error)", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({
      goals: [
        { name: "a", description: "A" },
        { name: "b", description: "B" },
      ],
      chatHistory: CHAT,
    } as never);

    await runGoalSweepOnce({
      provider: judgeReturning({ goal_name: "a", achieved: true, reason: "ok", technical_reason: "" }),
    });

    expect(mockError).not.toHaveBeenCalled();
    const [, verdicts] = mockComplete.mock.calls[0] as unknown as [string, Array<Record<string, unknown>>];
    expect(verdicts[0]).toMatchObject({ name: "a", met: true });
    expect(verdicts[1]).toMatchObject({ name: "b", met: false, reasoning: "Goal not evaluated by LLM" });
  });

  test("an empty transcript is marked errored, never judged", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({
      goals: [{ name: "a", description: "A" }],
      chatHistory: null,
    } as never);

    await runGoalSweepOnce({ provider: judgeReturning({ goal_name: "a", achieved: true, reason: "ok", technical_reason: "" }) });

    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    const [, message] = mockError.mock.calls[0] as unknown as [string, string];
    expect(message).toContain("empty transcript");
  });

  test("a model failure marks that session and continues with the next", async () => {
    mockClaim.mockResolvedValueOnce(["s1", "s2"] as never);
    mockLoad
      .mockResolvedValueOnce({ goals: [{ name: "a", description: "A" }], chatHistory: CHAT } as never)
      .mockResolvedValueOnce({ goals: [{ name: "b", description: "B" }], chatHistory: CHAT } as never);

    // Content-keyed responder (sessions run concurrently, so a positional queue
    // would be non-deterministic): the session judging goal "a" always gets
    // unparseable output → completeJSON exhausts retries → LlmError; goal "b" succeeds.
    const provider = new MockLLM([
      (args) =>
        args.user.includes('"goal_name":"a"')
          ? "not json"
          : JSON.stringify({ goals: [{ goal_name: "b", achieved: true, reason: "ok", technical_reason: "" }] }),
    ]);

    await runGoalSweepOnce({ provider });

    expect(mockError).toHaveBeenCalledTimes(1);
    expect((mockError.mock.calls[0] as unknown as [string, string])[0]).toBe("s1");
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect((mockComplete.mock.calls[0] as unknown as [string])[0]).toBe("s2");
  });

  test("a session with zero goals at analysis time is marked errored, not judged", async () => {
    mockClaim.mockResolvedValueOnce(["s1"] as never);
    mockLoad.mockResolvedValueOnce({ goals: [], chatHistory: CHAT } as never);

    await runGoalSweepOnce({ provider: judgeReturning({ goal_name: "x", achieved: true, reason: "ok", technical_reason: "" }) });

    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});
