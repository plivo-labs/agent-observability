import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

// buildExternalEvalRows imports sentimentPassed (→ the llm module → config);
// mock config so the import doesn't parse real env. No DB is imported.
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { buildExternalEvalRows } = await import("../src/evals-engine/fan-out-rows.js");

const det = (detected: boolean, available = true) => ({
  detected,
  detected_value: detected ? 1 : 0,
  reason: "r",
  technical_reason: "t",
  available,
});

const nodeEval = () => ({
  ref: "n1",
  instructions_adherence: { adherence_passed: false, reason: "adherence reason" },
  intent_identification: { intent_not_found: false, intent_wrongly_identified: false, reason: "i" },
  hallucination: { hallucinated: false, reason: "h" },
  node_loop: { loop_detected: false, reason: "l" },
});

const verdicts = (over: Record<string, boolean> = {}) =>
  ({
    node_evaluations: [nodeEval()],
    conversation_metrics: {
      voicemail_detected: det(!!over.voicemail),
      bot_detected: det(!!over.bot),
      call_screening: det(!!over.screening),
      low_engagement: det(false),
      wrong_number: det(false),
      do_not_disturb: det(false),
      user_never_spoke: det(false),
      user_sentiment: { sentiment: "unknown", reason: "", technical_reason: "", available: false },
    },
  }) as any;

const names = (v: any) => buildExternalEvalRows(v).map((r) => r.judgeName);

describe("buildExternalEvalRows — SER-6035 #3: skip adherence on machine-answered sessions", () => {
  test("voicemail session: instructions_adherence is skipped, voicemail_detection still fans out", () => {
    const n = names(verdicts({ voicemail: true }));
    expect(n).not.toContain("instructions_adherence");
    expect(n).toContain("voicemail_detection");
    // other node judges are unaffected
    expect(n).toContain("intent_identification");
    expect(n).toContain("hallucination");
    expect(n).toContain("node_loop");
  });

  test("bot / call-screening sessions also skip instructions_adherence", () => {
    expect(names(verdicts({ bot: true }))).not.toContain("instructions_adherence");
    expect(names(verdicts({ screening: true }))).not.toContain("instructions_adherence");
  });

  test("normal (human) session: instructions_adherence fans out as usual", () => {
    const n = names(verdicts());
    expect(n).toContain("instructions_adherence");
  });

  test("unavailable voicemail classifier does NOT suppress adherence (only a confident detection does)", () => {
    const v = verdicts();
    v.conversation_metrics.voicemail_detected = det(false, false); // classifier couldn't run
    expect(names(v)).toContain("instructions_adherence");
  });
});

describe("buildExternalEvalRows — transfer axis (human_transfer fact + transfer_consent judgement)", () => {
  const withTransfer = (over: { transferred?: boolean; consentDetected?: boolean; consentAvailable?: boolean } = {}) => {
    const v = verdicts();
    v.conversation_metrics.human_transfer = det(!!over.transferred);
    v.conversation_metrics.transfer_consent = {
      ...det(!!over.consentDetected, over.consentAvailable ?? true),
      reason_code: over.consentDetected ? "declined" : "ok",
    };
    return v;
  };
  const row = (v: any, name: string) => buildExternalEvalRows(v).find((r) => r.judgeName === name);

  test("a transferred session fans out human_transfer as fail (detection convention: fail = it happened)", () => {
    const r = row(withTransfer({ transferred: true }), "human_transfer");
    expect(r).toBeDefined();
    expect(r!.passed).toBe(false);
  });

  test("a non-transferred session fans out human_transfer as pass", () => {
    expect(row(withTransfer({ transferred: false }), "human_transfer")!.passed).toBe(true);
  });

  test("transfer without consent fans out transfer_consent as fail with the reason code in raw", () => {
    const r = row(withTransfer({ transferred: true, consentDetected: true }), "transfer_consent");
    expect(r!.passed).toBe(false);
    expect((r!.raw as any).reason_code).toBe("declined");
  });

  test("an unavailable consent verdict (no transfer / judge failed) fans out nothing", () => {
    expect(row(withTransfer({ transferred: false, consentAvailable: false }), "transfer_consent")).toBeUndefined();
  });

  test("verdicts that predate the transfer axis fan out no transfer rows", () => {
    const n = names(verdicts());
    expect(n).not.toContain("human_transfer");
    expect(n).not.toContain("transfer_consent");
  });
});
