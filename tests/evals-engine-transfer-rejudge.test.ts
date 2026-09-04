import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { rejudgeTransferAxis } = await import("../src/evals-engine/transfer-rejudge.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type SessionEvalVerdicts = import("../src/evals-engine/integration/session-evals.js").SessionEvalVerdicts;

// Backfill path: a session judged BEFORE the transfer axis existed gets a
// `transfer:human` tag imported later. Re-deriving only that axis must leave
// every other stored verdict byte-identical (no re-spend, no verdict drift).
// The axis is decided in code from the tag, so this makes no LLM calls at all.

const TRANSFER = { name: "transfer:human", metadata: { intent: "Transfer" } };
const det = (detected: boolean, available = true) => ({ detected, detected_value: detected ? 1 : 0, reason: detected ? "d" : "", technical_reason: "t", available });

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "outreach",
  global_prompt: "",
  nodes: [],
  goals: [],
  full_transcript: "Agent: Can I connect you to a mover?\nUser: no thanks",
  tags: [TRANSFER],
  ...over,
});

const stored = (over: Partial<SessionEvalVerdicts["conversation_metrics"]> = {}): SessionEvalVerdicts => ({
  node_evaluations: [{ ref: "n1", hallucination: { hallucinated: true, score: 0.2, reason: "made it up", technical_reason: "t" } } as any],
  conversation_metrics: {
    answered: true,
    voicemail_detected: det(false), bot_detected: det(false), call_screening: det(false),
    low_engagement: det(true), wrong_number: det(false), do_not_disturb: det(false),
    user_sentiment: { sentiment: "negative", reason: "r", technical_reason: "t", available: true, passed: false },
    silent_call: false, customer_engaged: false,
    conversation_status: { status: "low_engagement", reason: "", technical_reason: "" },
    is_livekit: false, is_agent_runner: false,
    stt: { error_count: 0, recovered_count: 0, available: true },
    user_never_spoke: det(false),
    // Pre-axis verdicts have no transfer fields at all.
    ...over,
  } as any,
});

describe("rejudgeTransferAxis — re-derive ONLY the transfer axis on an already-judged session", () => {
  test("adds human_transfer and leaves every other verdict untouched", () => {
    const before = stored();
    const after = rejudgeTransferAxis(ctx(), before);
    expect(after.conversation_metrics.human_transfer.available).toBe(true);
    expect(after.conversation_metrics.human_transfer.detected).toBe(true);
    // Untouched: same node verdicts (by reference) and identical conversation verdicts.
    expect(after.node_evaluations).toBe(before.node_evaluations);
    expect(after.conversation_metrics.low_engagement).toEqual(before.conversation_metrics.low_engagement);
    expect(after.conversation_metrics.user_sentiment).toEqual(before.conversation_metrics.user_sentiment);
  });

  test("a session without the tag re-derives to an UNAVAILABLE axis (no pass row)", () => {
    const after = rejudgeTransferAxis(ctx({ tags: [] }), stored());
    expect(after.conversation_metrics.human_transfer.available).toBe(false);
    expect(after.conversation_metrics.human_transfer.detected).toBe(false);
  });

  test("does not mutate the stored verdicts object", () => {
    const before = stored();
    const snapshot = JSON.stringify(before);
    rejudgeTransferAxis(ctx(), before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
