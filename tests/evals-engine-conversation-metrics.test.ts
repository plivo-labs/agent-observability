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
    // run-llm-judge.ts reads this at module load for its global judge-call semaphore.
    // Omitting it leaves the limit undefined, so acquireJudgeSlot() never grants a slot
    // and EVERY test in this file hangs to timeout — the whole suite was silently dead.
    EVAL_MAX_CONCURRENT_JUDGE_CALLS: 10,
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

  // ── a dead call is decided in code, not by the LLM ──
  // LOW_ENGAGEMENT is defined around "a real human answered", so the judge correctly
  // returns not-detected on a transcript with no caller speech — scoring the strongest
  // case of low engagement as clean. Round-4 prod: AO fired on 0/13 such calls while
  // legacy fired on 13/13. These pin the code path that overrides it.
  const SILENT =
    "Agent: Hi, this is Neha. Am I speaking with Alex?\n" +
    "Agent: Are you still there? I'm happy to assist whenever you're ready\n" +
    "Agent: Are you still there? I'm happy to assist whenever you're ready";

  test("silent call: fires low_engagement even though the judge says not-detected", async () => {
    // The LLM is told to report detected:false — exactly what prod does on these calls.
    const llm = new MockLLM([responder({ low: false })]);
    const cm = await evaluateConversationMetrics(
      ctx({ transport: "livekit", full_transcript: SILENT, speech_transcript: SILENT }),
      llm,
    );
    expect(cm.low_engagement.detected).toBe(true);
    expect(cm.low_engagement.available).toBe(true);
    // Synthesized, not det() re-reading the raw verdict — otherwise this silently no-ops.
    expect(cm.low_engagement.reason).toContain("never spoke");
    expect(cm.answered).toBe(false);
    expect(cm.silent_call).toBe(true);
    expect(cm.customer_engaged).toBe(false);
    // The taxonomy survives: "nobody spoke" stays separable from "human stonewalled".
    expect(cm.conversation_status.status).toBe("unanswered");
  });

  test("silent call: a counterparty detection cannot suppress it, and is not fanned out", async () => {
    // A message-taking receptionist's own greeting can trip VOICEMAIL (it has no role
    // guard). On a transcript with no caller speech that is a false positive by
    // construction — silence must outrank it, and the voicemail row must not survive.
    const llm = new MockLLM([responder({ voicemail: true, screening: true, low: false })]);
    const cm = await evaluateConversationMetrics(
      ctx({ transport: "livekit", full_transcript: SILENT, speech_transcript: SILENT }),
      llm,
    );
    expect(cm.low_engagement.detected).toBe(true);
    expect(cm.voicemail_detected.detected).toBe(false);
    expect(cm.call_screening.detected).toBe(false);
  });

  test("silent call with no question asked stays clean (opportunity gate)", async () => {
    // A one-way announcement gave the caller nothing to respond to — a completed
    // message, not a disengaged caller. Legacy over-fires here; the gate is why AO
    // matched ground truth 13/13 on the round-4 silent calls where legacy got 11/13.
    const announce = "Agent: Hi, this is Acme. Your order has shipped. Our team will contact you shortly.";
    const llm = new MockLLM([responder({ low: false })]);
    const cm = await evaluateConversationMetrics(
      ctx({ transport: "livekit", full_transcript: announce, speech_transcript: announce }),
      llm,
    );
    expect(cm.low_engagement.detected).toBe(false);
    expect(cm.answered).toBe(false);
  });

  test("answered call is untouched by the silent path (LLM still decides)", async () => {
    const llm = new MockLLM([responder({ low: false })]);
    const cm = await evaluateConversationMetrics(ctx({ transport: "livekit" }), llm);
    expect(cm.low_engagement.detected).toBe(false);
    expect(cm.answered).toBe(true);

    const llm2 = new MockLLM([responder({ low: true })]);
    const cm2 = await evaluateConversationMetrics(ctx({ transport: "livekit" }), llm2);
    expect(cm2.low_engagement.detected).toBe(true);
    expect(cm2.conversation_status.status).toBe("low_engagement");
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

  test("mutual exclusivity: call_screening/voicemail suppresses wrong_number + do_not_disturb (no co-fire)", async () => {
    // Regression: the top-priority voicemail/screening branch must clear EVERY
    // lower detection. It previously cleared only bot + low_engagement, so
    // call_screening + wrong_number both stayed detected and the sweeper fanned
    // two separate failing alert rows off a single call.
    const llm = new MockLLM([responder({ screening: true, wrong: true, dnd: true, low: true })]);
    const cm = await evaluateConversationMetrics(ctx(), llm);
    expect(cm.call_screening.detected).toBe(true);
    expect(cm.wrong_number.detected).toBe(false); // superseded
    expect(cm.do_not_disturb.detected).toBe(false); // superseded
    expect(cm.low_engagement.detected).toBe(false); // superseded
  });

  test("wrong_number outranks do_not_disturb + low_engagement", async () => {
    const llm = new MockLLM([responder({ wrong: true, dnd: true, low: true })]);
    const cm = await evaluateConversationMetrics(ctx(), llm);
    expect(cm.wrong_number.detected).toBe(true);
    expect(cm.do_not_disturb.detected).toBe(false);
    expect(cm.low_engagement.detected).toBe(false);
  });
});
