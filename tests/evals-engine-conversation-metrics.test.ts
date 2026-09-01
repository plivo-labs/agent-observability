import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

// Mock config so importing the llm module (via the judges) doesn't parse real env.
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { evaluateConversationMetrics, resolveOutcomes, evaluateUserNeverSpoke, evaluateHumanTransfer } = await import("../src/evals-engine/judges/conversation-judges.js");
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

const detection = (detected = false) => ({
  detected,
  reason: detected ? "detected" : "clean",
  technical_reason: "test",
  available: true,
});

type DetectionRaws = Parameters<typeof resolveOutcomes>[0];
const raws = (over: Partial<DetectionRaws> = {}): DetectionRaws => ({
  voicemail: detection(),
  bot: detection(),
  screening: detection(),
  lowEngagement: detection(),
  wrongNumber: detection(),
  doNotDisturb: detection(),
  ...over,
});

describe("user_never_spoke — the caller produced no turn", () => {
  test("fires when the transcript has agent turns but no user turn", async () => {
    const llm = new MockLLM([responder({})]);
    const cm = await evaluateConversationMetrics(
      ctx({ full_transcript: "Agent: Hello, is anyone there?\nAgent: I'll try once more." }),
      llm,
    );
    expect(cm.user_never_spoke.available).toBe(true);
    expect(cm.user_never_spoke.detected).toBe(true);
  });

  test("does not fire when the user spoke at least once", async () => {
    const llm = new MockLLM([responder({})]);
    const cm = await evaluateConversationMetrics(
      ctx({ full_transcript: "Agent: Hi there.\nUser: yes hello" }),
      llm,
    );
    expect(cm.user_never_spoke.available).toBe(true);
    expect(cm.user_never_spoke.detected).toBe(false);
  });

  test("is channel-agnostic — fires on a text channel with no user reply", async () => {
    const llm = new MockLLM([responder({})]);
    const cm = await evaluateConversationMetrics(
      ctx({ transport: "chat", full_transcript: "Agent: Hi, following up on your order." }),
      llm,
    );
    expect(cm.user_never_spoke.detected).toBe(true);
  });

  test("does NOT fire on a voicemail call — suppressed by the machine outcome", async () => {
    // Zero user turns AND the agent did not ask a question (so resolveOutcomes
    // keeps voicemail rather than reclassifying to silent-call), so voicemail
    // fires. user_never_spoke must defer to it, not co-fire.
    const llm = new MockLLM([responder({ voicemail: true })]);
    const cm = await evaluateConversationMetrics(
      ctx({ full_transcript: "Agent: Hi, this is Dan, please call me back." }),
      llm,
    );
    expect(cm.voicemail_detected.detected).toBe(true);
    // Suppressed → available:false → the sweeper fans out nothing for it.
    expect(cm.user_never_spoke.available).toBe(false);
    expect(cm.user_never_spoke.detected).toBe(false);
  });

  test("an empty transcript is unavailable, not a clean pass", () => {
    const result = evaluateUserNeverSpoke(ctx({ full_transcript: "   " }));
    expect(result.available).toBe(false);
    expect(result.detected).toBe(false);
  });
});

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

  test("resolveOutcomes directly derives silence and normalizes every emitted detection", () => {
    const resolved = resolveOutcomes(
      raws({ voicemail: detection(true), screening: detection(true) }),
      ctx({ transport: "livekit", full_transcript: SILENT, speech_transcript: SILENT }),
    );

    expect(resolved.low_engagement.detected).toBe(true);
    expect(resolved.voicemail_detected.detected).toBe(false);
    expect(resolved.call_screening.detected).toBe(false);
    expect(resolved.bot_detected.detected).toBe(false);
    expect(resolved.wrong_number.detected).toBe(false);
    expect(resolved.do_not_disturb.detected).toBe(false);
    expect(resolved.conversation_status.status).toBe("unanswered");
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

  test("all-evidence transcript with a question mark stays clean", async () => {
    // The legacy Agent: prefix makes this a real discriminator: using `||` or
    // reading full_transcript directly would mistake the tool argument for a
    // delivered agent question and fire the deterministic silent-call gate.
    const evidence = 'Agent: Tool_Call: lookup({"query":"is the order ready?"})';
    const llm = new MockLLM([responder({ low: false })]);
    const cm = await evaluateConversationMetrics(
      ctx({ transport: "livekit", full_transcript: evidence, speech_transcript: "" }),
      llm,
    );

    expect(cm.answered).toBe(false);
    expect(cm.low_engagement.detected).toBe(false);
    expect(cm.silent_call).toBe(true);
  });

  test("answered call is untouched by the silent path (LLM still decides)", async () => {
    const llm = new MockLLM([responder({ low: false })]);
    const cm = await evaluateConversationMetrics(ctx({ transport: "livekit" }), llm);
    expect(cm.low_engagement.detected).toBe(false);
    expect(cm.answered).toBe(true);
    expect(cm.customer_engaged).toBe(true);

    const llm2 = new MockLLM([responder({ low: true })]);
    const cm2 = await evaluateConversationMetrics(ctx({ transport: "livekit" }), llm2);
    expect(cm2.low_engagement.detected).toBe(true);
    expect(cm2.customer_engaged).toBe(false);
    expect(cm2.conversation_status.status).toBe("low_engagement");
  });

  test("mutual exclusivity: bot fires → low_engagement is suppressed (no co-fire)", () => {
    const cm = resolveOutcomes(raws({ bot: detection(true), lowEngagement: detection(true) }), ctx());
    expect(cm.bot_detected.detected).toBe(true);
    expect(cm.low_engagement.detected).toBe(false); // suppressed by bot
    expect(cm.customer_engaged).toBe(false);
    expect(cm.conversation_status.status).toBe("bot_detected");
  });

  test("mutual exclusivity: voicemail suppresses both bot and low_engagement", () => {
    const cm = resolveOutcomes(
      raws({ voicemail: detection(true), bot: detection(true), lowEngagement: detection(true) }),
      ctx(),
    );
    expect(cm.voicemail_detected.detected).toBe(true);
    expect(cm.bot_detected.detected).toBe(false); // superseded
    expect(cm.low_engagement.detected).toBe(false); // superseded
    expect(cm.customer_engaged).toBe(false);
    expect(cm.conversation_status.status).toBe("voicemail_detected");
  });

  test("mutual exclusivity: call_screening/voicemail suppresses wrong_number + do_not_disturb (no co-fire)", () => {
    // Regression: the top-priority voicemail/screening branch must clear EVERY
    // lower detection. It previously cleared only bot + low_engagement, so
    // call_screening + wrong_number both stayed detected and the sweeper fanned
    // two separate failing alert rows off a single call.
    const cm = resolveOutcomes(
      raws({
        screening: detection(true),
        wrongNumber: detection(true),
        doNotDisturb: detection(true),
        lowEngagement: detection(true),
      }),
      ctx(),
    );
    expect(cm.call_screening.detected).toBe(true);
    expect(cm.wrong_number.detected).toBe(false); // superseded
    expect(cm.do_not_disturb.detected).toBe(false); // superseded
    expect(cm.low_engagement.detected).toBe(false); // superseded
    expect(cm.customer_engaged).toBe(false);
  });

  test("wrong_number outranks do_not_disturb + low_engagement", () => {
    const cm = resolveOutcomes(
      raws({ wrongNumber: detection(true), doNotDisturb: detection(true), lowEngagement: detection(true) }),
      ctx(),
    );
    expect(cm.wrong_number.detected).toBe(true);
    expect(cm.do_not_disturb.detected).toBe(false);
    expect(cm.low_engagement.detected).toBe(false);
    expect(cm.customer_engaged).toBe(false);
  });

  test("do_not_disturb excludes customer engagement", () => {
    const cm = resolveOutcomes(raws({ doNotDisturb: detection(true) }), ctx());
    expect(cm.customer_engaged).toBe(false);
  });
});

// ── transfer axis: the FACT (human_transfer) and the JUDGEMENT (transfer_consent) ──
//
// human_transfer is decided in CODE from the session tag `transfer:human` (the
// platform's runtime confirmation that a transfer executed — never inferred from
// prose). transfer_consent is an LLM judge that runs ONLY when a transfer executed,
// and short-circuits to `no_caller` when the caller never spoke.
describe("human_transfer — the transfer fact, from the session tag", () => {
  const TRANSFER = { name: "transfer:human", metadata: { intent: "Transfer Approved" } };
  const consentResponder = (consentGiven: boolean, reasonCode = consentGiven ? "ok" : "declined") =>
    (args: { system?: string }) => {
      const s = args.system ?? "";
      if (s.includes("consent to the transfer")) {
        return JSON.stringify({ consent_given: consentGiven, reason_code: reasonCode, reason: "r", technical_reason: "t" });
      }
      return responder({})(args);
    };
  const consentCalls = (llm: InstanceType<typeof MockLLM>) =>
    llm.calls.filter((c) => (c.system ?? "").includes("consent to the transfer"));

  test("fires when the session carries the transfer:human tag", async () => {
    const llm = new MockLLM([consentResponder(true)]);
    const cm = await evaluateConversationMetrics(ctx({ tags: [TRANSFER] }), llm);
    expect(cm.human_transfer.available).toBe(true);
    expect(cm.human_transfer.detected).toBe(true);
    expect(cm.human_transfer.reason).toContain("Transfer Approved");
  });

  test("is unavailable (undecidable) when no tag feed was supplied — never a clean 'no transfer'", async () => {
    const llm = new MockLLM([consentResponder(true)]);
    const cm = await evaluateConversationMetrics(ctx(), llm);
    expect(cm.human_transfer.available).toBe(false);
    expect(cm.human_transfer.detected).toBe(false);
    expect(cm.transfer_consent.available).toBe(false);
  });

  test("tags present but no transfer: a real 'not transferred', and the consent judge does not run", async () => {
    const llm = new MockLLM([consentResponder(false)]);
    const cm = await evaluateConversationMetrics(ctx({ tags: [{ name: "amd:voicemail", metadata: null }] }), llm);
    expect(cm.human_transfer.available).toBe(true);
    expect(cm.human_transfer.detected).toBe(false);
    expect(cm.transfer_consent.available).toBe(false);
    expect(consentCalls(llm).length).toBe(0);
  });

  test("evaluateHumanTransfer: pure read of the tag list", () => {
    expect(evaluateHumanTransfer(ctx({ tags: [TRANSFER] })).detected).toBe(true);
    expect(evaluateHumanTransfer(ctx({ tags: [] })).detected).toBe(false);
    expect(evaluateHumanTransfer(ctx({ tags: [] })).available).toBe(true);
    expect(evaluateHumanTransfer(ctx()).available).toBe(false);
  });
});

describe("transfer_consent — did the caller consent before the transfer executed", () => {
  const TRANSFER = { name: "transfer:human", metadata: { intent: "Transfer Approved" } };
  const consentResponder = (consentGiven: boolean, reasonCode = consentGiven ? "ok" : "declined") =>
    (args: { system?: string }) => {
      const s = args.system ?? "";
      if (s.includes("consent to the transfer")) {
        return JSON.stringify({ consent_given: consentGiven, reason_code: reasonCode, reason: "r", technical_reason: "t" });
      }
      return responder({})(args);
    };
  const consentCalls = (llm: InstanceType<typeof MockLLM>) =>
    llm.calls.filter((c) => (c.system ?? "").includes("consent to the transfer"));

  test("consent given → not detected (pass), reason_code ok", async () => {
    const llm = new MockLLM([consentResponder(true)]);
    const cm = await evaluateConversationMetrics(ctx({ tags: [TRANSFER] }), llm);
    expect(cm.transfer_consent.available).toBe(true);
    expect(cm.transfer_consent.detected).toBe(false);
    expect(cm.transfer_consent.reason_code).toBe("ok");
    expect(consentCalls(llm).length).toBe(1);
  });

  test("caller declined → detected (fail) with the judge's reason code", async () => {
    const llm = new MockLLM([consentResponder(false, "declined")]);
    const cm = await evaluateConversationMetrics(ctx({ tags: [TRANSFER] }), llm);
    expect(cm.transfer_consent.detected).toBe(true);
    expect(cm.transfer_consent.reason_code).toBe("declined");
  });

  test("caller never spoke → short-circuit: no LLM call, detected with reason_code no_caller", async () => {
    const llm = new MockLLM([consentResponder(true)]);
    const cm = await evaluateConversationMetrics(
      ctx({ tags: [TRANSFER], full_transcript: "Agent: Hi, is this Dana?\nAgent: I'll connect you to a mover now." }),
      llm,
    );
    expect(cm.human_transfer.detected).toBe(true);
    expect(cm.transfer_consent.available).toBe(true);
    expect(cm.transfer_consent.detected).toBe(true);
    expect(cm.transfer_consent.reason_code).toBe("no_caller");
    expect(consentCalls(llm).length).toBe(0);
  });

  test("the judge sees the transfer intent and the transferring node's instructions", async () => {
    const llm = new MockLLM([consentResponder(true)]);
    await evaluateConversationMetrics(
      ctx({
        tags: [TRANSFER],
        nodes: [
          { node_uuid: "n0", node_name: "greet", node_prompt: "Greet the caller.", available_intents: [], chosen_intent: "", required_variables: [], extracted_variables: {}, turns: [], turn_count: 0 },
          { node_uuid: "n1", node_name: "transfer", node_prompt: "Ask for a yes before transferring.", available_intents: [], chosen_intent: "", required_variables: [], extracted_variables: {}, turns: [], turn_count: 0 },
        ],
      }),
      llm,
    );
    const call = consentCalls(llm)[0];
    expect(call).toBeDefined();
    expect(call!.user).toContain("Transfer Approved");
    expect(call!.user).toContain("Ask for a yes before transferring.");
  });

  test("a deterministic judge failure leaves consent unavailable, never a fabricated pass", async () => {
    const llm = new MockLLM([(args: { system?: string }) => ((args.system ?? "").includes("consent to the transfer") ? "not json" : responder({})(args))]);
    const cm = await evaluateConversationMetrics(ctx({ tags: [TRANSFER] }), llm);
    expect(cm.human_transfer.detected).toBe(true);
    expect(cm.transfer_consent.available).toBe(false);
  });
});
