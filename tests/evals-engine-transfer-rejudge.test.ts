import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { rejudgeTransferAxis } = await import("../src/evals-engine/transfer-rejudge.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type SessionEvalVerdicts = import("../src/evals-engine/integration/session-evals.js").SessionEvalVerdicts;

// Backfill path: a session judged BEFORE the transfer axis existed gets a
// `transfer:human` tag imported later. Re-judging only that axis must leave every
// other stored verdict byte-identical (no re-spend, no verdict drift).

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

const consentLlm = (consentGiven: boolean, reasonCode = "declined") =>
  new MockLLM([
    (args: { system?: string }) =>
      (args.system ?? "").includes("consent to the transfer")
        ? JSON.stringify({ consent_given: consentGiven, reason_code: reasonCode, reason: "r", technical_reason: "t" })
        : "{}",
  ]);

describe("rejudgeTransferAxis — judge ONLY the transfer axis on an already-judged session", () => {
  test("adds human_transfer + transfer_consent and leaves every other verdict untouched", async () => {
    const before = stored();
    const llm = consentLlm(false, "declined");
    const after = await rejudgeTransferAxis(ctx(), before, llm);
    expect(after.conversation_metrics.human_transfer.detected).toBe(true);
    expect(after.conversation_metrics.transfer_consent.detected).toBe(true);
    expect(after.conversation_metrics.transfer_consent.reason_code).toBe("declined");
    // Untouched: same node verdicts (by reference) and identical conversation verdicts.
    expect(after.node_evaluations).toBe(before.node_evaluations);
    expect(after.conversation_metrics.low_engagement).toEqual(before.conversation_metrics.low_engagement);
    expect(after.conversation_metrics.user_sentiment).toEqual(before.conversation_metrics.user_sentiment);
    // Only the consent judge was called — never the other conversation judges.
    expect(llm.calls.length).toBe(1);
  });

  test("uses the STORED user_never_spoke verdict for the no_caller short-circuit (no LLM call)", async () => {
    const llm = consentLlm(true);
    const after = await rejudgeTransferAxis(ctx(), stored({ user_never_spoke: det(true) }), llm);
    expect(after.conversation_metrics.transfer_consent.reason_code).toBe("no_caller");
    expect(llm.calls.length).toBe(0);
  });

  test("a session without the tag re-judges to an UNAVAILABLE transfer axis (no pass row, no consent call)", async () => {
    const llm = consentLlm(false);
    const after = await rejudgeTransferAxis(ctx({ tags: [] }), stored(), llm);
    expect(after.conversation_metrics.human_transfer.available).toBe(false);
    expect(after.conversation_metrics.human_transfer.detected).toBe(false);
    expect(after.conversation_metrics.transfer_consent.available).toBe(false);
    expect(llm.calls.length).toBe(0);
  });

  test("does not mutate the stored verdicts object", async () => {
    const before = stored();
    const snapshot = JSON.stringify(before);
    await rejudgeTransferAxis(ctx(), before, consentLlm(true));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
