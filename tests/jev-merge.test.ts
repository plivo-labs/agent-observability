import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const merge = await import("../src/evals-engine/jev/merge.js");
type GatedAxis = import("../src/evals-engine/jev/gate.js").GatedAxis;
type JevNodeAxis = import("../src/evals-engine/jev/plan.js").JevNodeAxis;
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type SimConversationMetrics = import("../src/evals-engine/types.js").SimConversationMetrics;

const nodeAxis = (over: Partial<JevNodeAxis> = {}): JevNodeAxis => ({
  kind: "node", id: "n0:node_loop", judge: "node_loop", nodeIndex: 0, requestKey: "n0", questionKeys: ["n0.node_loop"], ...over,
} as JevNodeAxis);

const gated = (over: Partial<GatedAxis> = {}): GatedAxis => ({
  axis: nodeAxis(), outcome: "pass", p: 0.04, firedKeys: [], probabilities: {}, jevModel: "jev-1.13.0", ...over,
});

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1", node_name: "collect", node_prompt: "Collect the id.",
  available_intents: [], chosen_intent: "", required_variables: ["order_id", "lead_status"],
  variable_rules: { order_id: "Record the id the caller states.", lead_status: "Record the final workflow status you assign." },
  extracted_variables: { order_id: "42" }, turns: [], turn_count: 0, ...over,
});

const NO_REASONS = new Map<string, { reason: string; technical_reason: string }>();

describe("provenance and reason text", () => {
  test("a pass is templated and carries the model and probability", () => {
    const block = merge.jevNodeLoop(gated(), NO_REASONS);
    expect(block.loop_detected).toBe(false);
    expect(block.score).toBeCloseTo(0.96, 5);
    expect(block.reason).toBe("No defect found.");
    // the probability is internal-only — it stays out of the customer-facing text
    expect(block.reason).not.toContain("Jev");
    expect(block.technical_reason).toContain("p=0.04");
    expect(block).toMatchObject({ backend: "jev", confidence: 0.04, jev_model: "jev-1.13.0" });
  });

  test("a fail uses the written reason and prefixes the technical one", () => {
    const reasons = new Map([["n0:node_loop", { reason: "Asked the same question four times.", technical_reason: "turns 3,5,7" }]]);
    const block = merge.jevNodeLoop(gated({ outcome: "fail", p: 0.93 }), reasons);
    expect(block.loop_detected).toBe(true);
    expect(block.reason).toBe("Asked the same question four times.");
    expect(block.technical_reason).toBe("jev 0.93 · turns 3,5,7");
  });

  test("a fail with no written reason still keeps the verdict", () => {
    const block = merge.jevHallucination(gated({ outcome: "fail", p: 0.91 }), NO_REASONS);
    expect(block.hallucinated).toBe(true);
    expect(block.reason).toContain("explanation unavailable");
  });
});

describe("adherence", () => {
  test("sub-rubrics stay null — this path never graded them", () => {
    const block = merge.jevAdherence(gated({ axis: nodeAxis({ id: "n0:instructions_adherence", judge: "instructions_adherence" }), outcome: "fail", p: 0.88 }), NO_REASONS);
    expect(block.adherence_passed).toBe(false);
    expect(block.objective_progress).toBeNull();
    expect(block.procedure_compliance).toBeNull();
    expect(block.interaction_quality).toBeNull();
    expect(block.policy_boundary_compliance).toBeNull();
  });
});

describe("intent", () => {
  const axis = nodeAxis({
    id: "n0:intent_identification", judge: "intent_identification",
    questionKeys: ["n0.intent.0", "n0.intent.wrong"],
    intents: [{ key: "n0.intent.0", intent: "opt_out" }, { key: "n0.intent.wrong", intent: "" }],
  });

  test("a declared intent that never fired maps to intent_not_found", () => {
    const block = merge.jevIntent(gated({ axis, outcome: "fail", p: 0.9, firedKeys: ["n0.intent.0"] }), NO_REASONS);
    expect(block.intent_not_found).toBe(true);
    expect(block.intent_wrongly_identified).toBe(false);
    expect(block.score).toBe(0);
  });

  test("an unsupported firing maps to intent_wrongly_identified", () => {
    const block = merge.jevIntent(gated({ axis, outcome: "fail", p: 0.9, firedKeys: ["n0.intent.wrong"] }), NO_REASONS);
    expect(block.intent_wrongly_identified).toBe(true);
    expect(block.intent_not_found).toBe(false);
  });

  test("a pass sets neither flag and scores 1", () => {
    const block = merge.jevIntent(gated({ axis, outcome: "pass", p: 0.03 }), NO_REASONS);
    expect(block).toMatchObject({ intent_not_found: false, intent_wrongly_identified: false, score: 1 });
  });
});

describe("variables", () => {
  const axis = nodeAxis({
    id: "n0:variable_extraction", judge: "variable_extraction",
    questionKeys: ["v0.var.0", "v0.var.1"],
    variables: [{ key: "v0.var.0", variable: "order_id", recorded: true }, { key: "v0.var.1", variable: "lead_status", recorded: false }],
  });

  test("a recorded variable files as incorrect, an unrecorded one as missing", () => {
    const withCaller = node({ variable_rules: { order_id: "Record the id the caller states.", lead_status: "Record the callback time the caller states." } });
    const out = merge.jevVariables(gated({ axis, outcome: "fail", p: 0.95, firedKeys: ["v0.var.0", "v0.var.1"] }), withCaller, NO_REASONS);
    expect(out.metrics.incorrect_variables).toEqual(["order_id"]);
    expect(out.metrics.missing_variables).toEqual(["lead_status"]);
    expect(out.metrics.extraction_successful).toBe(false);
    expect(out.metrics.required_variables).toEqual(["order_id", "lead_status"]);
  });

  test("the deterministic guards clear a workflow field, and clearing everything makes it a pass", () => {
    const out = merge.jevVariables(gated({ axis, outcome: "fail", p: 0.95, firedKeys: ["v0.var.1"] }), node(), NO_REASONS);
    expect(out.cleared).toEqual(["lead_status"]);
    expect(out.metrics.extraction_successful).toBe(true);
    expect(out.metrics.missing_variables).toEqual([]);
    expect(out.metrics.technical_reason).toContain("cleared as out-of-scope");
  });
});

describe("attachDetectionProvenance", () => {
  const detection = (over: Partial<SimConversationMetrics["voicemail_detected"]> = {}) => ({
    detected: false, detected_value: 0, reason: "", technical_reason: "", available: true, ...over,
  });
  const metrics = (over: Partial<SimConversationMetrics> = {}) => ({
    voicemail_detected: detection(),
    bot_detected: detection({ technical_reason: "superseded by a higher-priority conversation outcome" }),
    low_engagement: detection({ detected: true, technical_reason: "derived in code: zero user turns" }),
    call_screening: detection({ available: false }),
    ...over,
  }) as unknown as SimConversationMetrics;

  test("stamps the deciding backend, but marks overruled and code-derived axes as code", () => {
    const out = merge.attachDetectionProvenance(metrics(), new Map<any, any>([
      ["voicemail_detected", { backend: "jev", confidence: 0.95 }],
      ["bot_detected", { backend: "jev", confidence: 0.93 }],
      ["low_engagement", { backend: "jev", confidence: 0.88 }],
      ["call_screening", { backend: "jev", confidence: 0.2 }],
    ]));
    expect(out.voicemail_detected).toMatchObject({ backend: "jev", confidence: 0.95 });
    expect(out.bot_detected).toMatchObject({ backend: "code" });
    expect(out.bot_detected.confidence).toBeUndefined();
    expect(out.low_engagement).toMatchObject({ backend: "code" });
    // an unavailable axis was never judged by anyone
    expect(out.call_screening.backend).toBeUndefined();
  });
});

describe("jevCustomMetric", () => {
  const spec = { name: "metric:hold", display_name: "Hold warning", scope: "conversation" as const, body: "Fail if held without warning.", output: "" } as any;
  const customAxis = { kind: "custom", id: "m.metric:hold", judge: "metric:hold", scope: "conversation", requestKey: "m.metric:hold", questionKeys: ["a", "f"], applicableKey: "a", failKey: "f" } as any;

  test("a metric the call never reached carries the written explanation, not an empty string", () => {
    const g = gated({ axis: customAxis, outcome: "unknown", p: 0.05 });
    const reasons = new Map([["m.metric:hold", { reason: "The caller was never placed on hold.", technical_reason: "no hold event in the transcript" }]]);
    const out = merge.jevCustomMetric(spec, g, reasons);
    expect(out.verdict).toBe("unknown");
    expect(out.reason).toBe("The caller was never placed on hold.");
    expect(out.technical_reason).toContain("no hold event in the transcript");
    expect(out.backend).toBe("jev");
  });

  // The LLM judge this replaces always writes a reason for `unknown`, so losing
  // the batched call must still leave prose behind rather than an empty field.
  test("a metric the call never reached falls back to plain text when the writer failed", () => {
    const g = gated({ axis: customAxis, outcome: "unknown", p: 0.05 });
    const out = merge.jevCustomMetric(spec, g, new Map());
    expect(out.verdict).toBe("unknown");
    expect(out.reason).toContain("did not apply");
    expect(out.reason).not.toBe("");
  });
});
