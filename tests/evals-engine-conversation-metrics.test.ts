import { describe, test, expect, mock } from "bun:test";

// Mock config so importing the llm module (via the judges) doesn't parse real env.
mock.module("../src/config.js", () => ({
  config: {
    LLM_PROVIDER: "anthropic",
    JUDGE_MODEL: undefined,
    SIMULATOR_MODEL: undefined,
    GENERATOR_MODEL: undefined,
    LLM_TIMEOUT_MS: 30000,
    LLM_MAX_RETRIES: 1,
  },
}));

const { MockLLM } = await import("../src/llm/index.js");
const { evaluateConversationMetrics } = await import("../src/evals-engine/judges/conversation-judges.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "outreach",
  global_prompt: "You are an outreach agent.",
  nodes: [],
  goals: [],
  full_transcript: "User: hello?\nAgent: Hi, this is Acme calling about your order.\nUser: ok sure",
  ...over,
});

/** Deterministic per-judge responder keyed on the system prompt — order-independent,
 *  so parallel judges each get the verdict this test intends. `detect` maps a judge
 *  key to whether it should report detected:true. */
function responder(detect: Partial<Record<"voicemail" | "bot" | "screening" | "low" | "wrong" | "dnd", boolean>>, sentiment = "positive") {
  return (args: { system?: string }) => {
    const s = args.system ?? "";
    const D = (v: boolean | undefined) => JSON.stringify({ detected: !!v, reason: "r", technical_reason: "t" });
    if (s.includes("reached voicemail")) return D(detect.voicemail);
    if (s.includes("automated system or AI")) return D(detect.bot);
    if (s.includes("automated call screening")) return D(detect.screening);
    if (s.includes("Detect low engagement")) return D(detect.low);
    if (s.includes("not the intended recipient")) return D(detect.wrong);
    if (s.includes("not to be contacted again")) return D(detect.dnd);
    if (s.includes("Classify the user's sentiment")) return JSON.stringify({ sentiment, reason: "r", technical_reason: "t" });
    if (s.includes("speech-to-text quality")) return JSON.stringify({ error_count: 0, recovered_count: 0, reason: "r", technical_reason: "t" });
    return "{}";
  };
}

describe("evaluateConversationMetrics — anti-over-fire logic", () => {
  test("channel gate: voice-only detections do not run on a text channel", async () => {
    const llm = new MockLLM([responder({})]);
    const cm = await evaluateConversationMetrics(ctx({ transport: "chat" }), llm);

    // Voice-only detections + STT are gated off on text → unavailable (never
    // fanned out), so they can't false-positive on a chat/SMS transcript.
    expect(cm.voicemail_detected.available).toBe(false);
    expect(cm.bot_detected.available).toBe(false);
    expect(cm.call_screening.available).toBe(false);
    expect(cm.stt.available).toBe(false);
    // Text-applicable detections still run.
    expect(cm.wrong_number.available).toBe(true);
    expect(cm.do_not_disturb.available).toBe(true);
  });

  test("voice channel runs the voice-only detections", async () => {
    const llm = new MockLLM([responder({})]);
    const cm = await evaluateConversationMetrics(ctx({ transport: "livekit" }), llm);
    expect(cm.voicemail_detected.available).toBe(true);
    expect(cm.bot_detected.available).toBe(true);
    expect(cm.stt.available).toBe(true);
  });

  test("mutual exclusivity: bot fires → low_engagement is suppressed (no co-fire)", async () => {
    // Both bot and low-engagement judges say detected:true; exclusivity must keep
    // only the higher-priority bot outcome so the two can't both fan out.
    const llm = new MockLLM([responder({ bot: true, low: true })]);
    const cm = await evaluateConversationMetrics(ctx(), llm);
    expect(cm.bot_detected.detected).toBe(true);
    expect(cm.low_engagement.detected).toBe(false); // suppressed by bot
    expect(cm.conversation_status.status).toBe("bot_detected");
  });

  test("mutual exclusivity: voicemail suppresses both bot and low_engagement", async () => {
    const llm = new MockLLM([responder({ voicemail: true, bot: true, low: true })]);
    const cm = await evaluateConversationMetrics(ctx(), llm);
    expect(cm.voicemail_detected.detected).toBe(true);
    expect(cm.bot_detected.detected).toBe(false); // superseded
    expect(cm.low_engagement.detected).toBe(false); // superseded
    expect(cm.conversation_status.status).toBe("voicemail_detected");
  });

  test("wrong_number outranks do_not_disturb + low_engagement", async () => {
    const llm = new MockLLM([responder({ wrong: true, dnd: true, low: true })]);
    const cm = await evaluateConversationMetrics(ctx(), llm);
    expect(cm.wrong_number.detected).toBe(true);
    expect(cm.do_not_disturb.detected).toBe(false);
    expect(cm.low_engagement.detected).toBe(false);
  });
});
