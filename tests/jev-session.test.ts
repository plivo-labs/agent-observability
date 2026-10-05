import { describe, test, expect, mock, spyOn } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

const testConfig = { ...TEST_JUDGE_CONFIG_MODULE.config, JEV_CUSTOM_METRICS: "on" };
mock.module("../src/config.js", () => ({ ...TEST_JUDGE_CONFIG_MODULE, config: testConfig }));

const { MockLLM } = await import("../src/llm/index.js");
const { MockJev } = await import("../src/jev/mock.js");
const { JevError, JEV_OVERFLOW } = await import("../src/jev/types.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
const { buildExternalEvalRows } = await import("../src/evals-engine/fan-out-rows.js");
const planNs = await import("../src/evals-engine/jev/plan.js");
type AgentConfig = import("../src/evals-engine/integration/session-evals.js").AgentConfig;
type StoredEvent = import("../src/evals-engine/integration/session-evals.js").StoredEvent;
type MockJevType = InstanceType<typeof MockJev>;

const config: AgentConfig = {
  flow_name: "orders",
  global_prompt: "You are an orders agent.",
  nodes: [{
    ref: "node-A",
    name: "collect_order",
    instructions: "Ask for the order id and confirm it.",
    intents: [{ name: "provide_order", description: "the caller states their order id", tool: "handoff_order" }],
    variables: [{ name: "order_id", rule: "Record the order id the caller states.", tool: "record_order_id" }],
  }],
};

const events: StoredEvent[] = [
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "What is your order id?" } },
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "user", content: "It is 42." } },
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "record_order_id", arguments: "{\"value\":\"42\"}" } },
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "Thanks, order 42 confirmed." } },
];

/** Every default judge answers cleanly; the reason writer returns one entry per asked defect. */
function llm() {
  return new MockLLM([(args: any) => {
    const system = args.system as string;
    if (system.includes("calibrated classifier")) {
      const asked = JSON.parse(args.user as string).items as Array<{ id: string }>;
      return JSON.stringify({ reasons: asked.map((d) => ({ id: d.id, reason: `why ${d.id}`, technical_reason: `tech ${d.id}` })) });
    }
    return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
  }]);
}

const labelsOf = (provider: InstanceType<typeof MockLLM>) => provider.calls.map((c) => c.jsonSchema?.name ?? "none").sort();
const run = (jev?: MockJevType, provider = llm()) =>
  evaluateIngestedSession(config, events, provider, "livekit", undefined, undefined, [], jev as any).then((v) => ({ v, provider }));

describe("JEV_MODE off — the LLM path is untouched", () => {
  test("no jev client judges exactly as before: 5 node + 8 conversation calls", async () => {
    const { v, provider } = await run(undefined);
    expect(provider.calls).toHaveLength(13);
    expect(v.node_evaluations[0]!.hallucination.hallucinated).toBe(false);
    expect(v.node_evaluations[0]!.hallucination.backend).toBeUndefined();
    expect(v.conversation_metrics.voicemail_detected.confidence).toBeUndefined();
  });
});

describe("candidates and final decisions", () => {
  test("clean conversation results skip review; changed node evidence stays under review", async () => {
    const jev = new MockJev([{}], 0.01);
    const { v, provider } = await run(jev);
    expect(labelsOf(provider)).toEqual(["eval_hallucination", "eval_instruction", "eval_intent", "eval_loop", "eval_sentiment", "eval_stt", "eval_variable"]);
    expect(jev.calls.map(c => c.key).sort()).toEqual(["a0", "c", "h0", "i0", "n0"]);
    const loop = v.node_evaluations[0]!.node_loop;
    expect(loop.backend).toBe("llm");
    expect(loop.confidence).toBeUndefined();
    expect(loop.jev?.candidate).toBe("pass");
    expect(loop.jev?.route).toBe("uncalibrated_evidence");
    expect(loop.jev?.evidence_version).toBe("node-evidence-v3");
    expect(v.conversation_metrics.voicemail_detected.backend).toBe("jev");
    expect(v.conversation_metrics.voicemail_detected.jev?.route).toBe("auto_pass");
  });

  for (const confirmed of [false, true]) {
    test(`the independent reviewer can ${confirmed ? "confirm" : "overturn"} a Jev failure`, async () => {
      const jev = new MockJev([(req) => Object.fromEntries(Object.keys(req.questions).map(k => [k, k.includes("node_loop") ? 0.97 : 0.01]))]);
      const provider = new MockLLM([(args: any) => args.jsonSchema?.name === "eval_loop"
        ? JSON.stringify({ loop_detected: confirmed, score: confirmed ? 0 : 1, reason: "Review of the actual node turns.", technical_reason: "independent review" })
        : defaultJudgeResponder(args.system)!]);
      const { v } = await run(jev, provider);
      const loop = v.node_evaluations[0]!.node_loop;
      expect(loop.loop_detected).toBe(confirmed);
      expect(loop.backend).toBe("llm");
      expect(loop.jev?.probability).toBe(0.97);
      expect(loop.jev?.candidate).toBe("fail");
      expect(loop.jev?.gate).toEqual({ pass_below: 0.28, fail_above: 0.85 });
      const call = provider.calls.find(c => c.jsonSchema?.name === "eval_loop")!;
      expect(call.user).not.toContain("0.97");
      expect(provider.calls.some(c => c.jsonSchema?.name === "eval_jev_reason")).toBe(false);
      const row = buildExternalEvalRows(v).find(r => r.judgeName === "node_loop")!;
      expect((row.raw as any).jev.candidate).toBe("fail");
    });
  }

  test("reviewed conversation detections still use the outcome priority rules", async () => {
    const jev = new MockJev([{}], 0.97);
    const provider = new MockLLM([(args: any) => args.jsonSchema?.name === "eval_detection"
      ? JSON.stringify({ detected: true, reason: "Voicemail greeting.", technical_reason: "reviewed" })
      : defaultJudgeResponder(args.system)!]);
    const { v } = await run(jev, provider);
    expect(v.conversation_metrics.voicemail_detected.detected).toBe(true);
    expect(v.conversation_metrics.voicemail_detected.backend).toBe("llm");
    expect(v.conversation_metrics.bot_detected.detected).toBe(false);
    expect(v.conversation_metrics.bot_detected.backend).toBe("code");
    expect(v.conversation_metrics.bot_detected.confidence).toBeUndefined();
    expect(v.conversation_metrics.conversation_status.status).toBe("voicemail_detected");
  });
});

describe("published decisions", () => {
  const withSwitches = async <T>(switches: Record<string, string>, body: () => Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(switches).map((k) => [k, (testConfig as any)[k]]));
    Object.assign(testConfig, switches);
    try {
      return await body();
    } finally {
      Object.assign(testConfig, saved);
    }
  };

  test("a named node judge's confident pass stands with no LLM judge call", async () => {
    await withSwitches({ JEV_NODE_AUTO_PASS: "node_loop" }, async () => {
      const { v, provider } = await run(new MockJev([{}], 0.01));
      const loop = v.node_evaluations[0]!.node_loop;
      expect(loop.loop_detected).toBe(false);
      expect(loop.backend).toBe("jev");
      expect(loop.jev?.route).toBe("auto_pass");
      expect(labelsOf(provider)).not.toContain("eval_loop");
      expect(labelsOf(provider)).toContain("eval_hallucination");
      expect(labelsOf(provider)).not.toContain("eval_jev_reason");
    });
  });

  test("a named judge's confident fail stands, and one batched call writes its reason", async () => {
    await withSwitches({ JEV_AUTO_FAIL: "node_loop" }, async () => {
      const jev = new MockJev([(req) => Object.fromEntries(Object.keys(req.questions).map(k => [k, k.includes("node_loop") ? 0.97 : 0.01]))]);
      const { v, provider } = await run(jev);
      const loop = v.node_evaluations[0]!.node_loop;
      expect(loop.loop_detected).toBe(true);
      expect(loop.backend).toBe("jev");
      expect(loop.jev?.route).toBe("auto_fail");
      expect(loop.reason).toBe("why n0:node_loop");
      expect(labelsOf(provider)).not.toContain("eval_loop");
      expect(labelsOf(provider).filter(l => l === "eval_jev_reason")).toHaveLength(1);
    });
  });

  const failingWriter = (message: string) => new MockLLM([(args: any) => {
    if (args.jsonSchema?.name === "eval_jev_reason") throw new Error(message);
    return defaultJudgeResponder(args.system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
  }]);
  const loopFails = () => new MockJev([(req) => Object.fromEntries(Object.keys(req.questions).map(k => [k, k.includes("node_loop") ? 0.97 : 0.01]))]);

  test("a transient reason-writer failure retries the whole session", async () => {
    await withSwitches({ JEV_AUTO_FAIL: "node_loop" }, async () => {
      await expect(run(loopFails(), failingWriter("429 rate limit exceeded"))).rejects.toThrow("429");
    });
  });

  test("a deterministic reason-writer failure keeps the verdict with a plain reason", async () => {
    await withSwitches({ JEV_AUTO_FAIL: "node_loop" }, async () => {
      const { v } = await run(loopFails(), failingWriter("duplicate key value violates unique constraint"));
      const loop = v.node_evaluations[0]!.node_loop;
      expect(loop.loop_detected).toBe(true);
      expect(loop.backend).toBe("jev");
      expect(loop.reason).toBe("A defect was detected; explanation unavailable.");
    });
  });

  test("pass reasons ride the same single call when asked for", async () => {
    await withSwitches({ JEV_NODE_AUTO_PASS: "node_loop", JEV_DECISION_REASONS: "all" }, async () => {
      const { v, provider } = await run(new MockJev([{}], 0.01));
      expect(v.node_evaluations[0]!.node_loop.reason).toBe("why n0:node_loop");
      expect(v.conversation_metrics.voicemail_detected.backend).toBe("jev");
      const writer = provider.calls.filter(c => c.jsonSchema?.name === "eval_jev_reason");
      expect(writer).toHaveLength(1);
      const kinds = (JSON.parse(writer[0]!.user as string).items as Array<{ id: string; kind: string }>);
      expect(kinds.find(i => i.id === "n0:node_loop")!.kind).toBe("clean");
    });
  });
});

describe("uncertain and unavailable axes fall to the LLM", () => {
  test("the uncertain band runs the real judge with its own prompt", async () => {
    const jev = new MockJev([{}], 0.5);
    const { v, provider } = await run(jev);
    const labels = labelsOf(provider);
    expect(labels).toContain("eval_hallucination");
    expect(labels).toContain("eval_loop");
    expect(labels).toContain("eval_detection");
    expect(provider.calls.some((c) => (c.system as string).includes("fabricated information"))).toBe(true);
    expect(v.node_evaluations[0]!.hallucination.backend).toBe("llm");
    expect(v.conversation_metrics.voicemail_detected.backend).toBe("llm");
    // no defect was decided by Jev, so nothing to explain
    expect(provider.calls.some((c) => (c.system as string).includes("calibrated classifier"))).toBe(false);
  });

  test("one failing Jev request degrades only its own axes", async () => {
    const jev = new MockJev([(req) => (req.key === "n0" ? new JevError(500, "server_error") : {})], 0.01);
    const { v, provider } = await run(jev);
    expect(v.node_evaluations[0]!.node_loop.backend).toBe("llm");
    expect(v.node_evaluations[0]!.hallucination.backend).toBe("llm");
    expect(v.node_evaluations[0]!.node_loop.jev?.fallback).toBe("error");
    expect(v.conversation_metrics.voicemail_detected.backend).toBe("jev");
    expect(provider.calls.some((c) => (c.system as string).includes("repeat its own previous messages"))).toBe(true);
  });

  test("an overflow on every request is judged entirely by the LLM, never an error", async () => {
    const jev = new MockJev([new JevError(400, JEV_OVERFLOW)]);
    const { v, provider } = await run(jev);
    expect(provider.calls).toHaveLength(13);
    expect(v.node_evaluations[0]!.variable_extraction.backend).toBe("llm");
    expect(v.conversation_metrics.low_engagement.available).toBe(true);
  });

  test("a 200 that answers nothing is reviewed, not read as a pass", async () => {
    const jev = new MockJev([{}], null);
    const { v, provider } = await run(jev);
    expect(provider.calls).toHaveLength(13);
    expect(v.node_evaluations[0]!.node_loop.backend).toBe("llm");
  });

  test("a planner error judges the whole session on the LLM, never an eval error", async () => {
    const spy = spyOn(planNs, "buildJevPlan").mockImplementation(() => { throw new Error("planner bug"); });
    try {
      const jev = new MockJev([{}], 0.01);
      const { v, provider } = await run(jev);
      expect(jev.calls).toHaveLength(0);
      expect(provider.calls).toHaveLength(13);
      expect(v.node_evaluations[0]!.node_loop.backend).toBe("llm");
      expect(v.conversation_metrics.voicemail_detected.backend).toBe("llm");
    } finally {
      spy.mockRestore();
    }
  });

});

describe("failures never escape as unhandled rejections", () => {
  test("a judge throwing transiently rejects the session, with sentiment and STT handled", async () => {
    const provider = new MockLLM([(args: any) => {
      const system = args.system as string;
      if (system.includes("four-part rubric")) throw new Error("429 rate limit exceeded");
      return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
    }]);
    // Jev answers everything it owns; adherence never auto-passes, so it is the
    // LLM's — and it throws.
    const jev = new MockJev([{}], 0.01);
    await expect(run(jev, provider)).rejects.toThrow(/429/);
    // sentiment was started alongside the detections, not left dangling
    expect(provider.calls.some((c) => c.jsonSchema?.name === "eval_sentiment")).toBe(true);
  });
});

describe("a text transport never gets a voice-only verdict", () => {
  test("voicemail, bot and screening are unavailable and unasked", async () => {
    const jev = new MockJev([{}], 0.01);
    const v = await evaluateIngestedSession(config, events, llm(), "chat", undefined, undefined, [], jev as any);
    expect(v.conversation_metrics.voicemail_detected.available).toBe(false);
    expect(v.conversation_metrics.bot_detected.available).toBe(false);
    expect(v.conversation_metrics.call_screening.available).toBe(false);
    expect(v.conversation_metrics.low_engagement.available).toBe(true);
    expect(v.conversation_metrics.low_engagement.backend).toBe("jev");
    const asked = jev.calls.flatMap((c) => Object.keys(c.questions));
    expect(asked.some((k) => k.includes("voicemail"))).toBe(false);
  });
});


test("custom applicability is independently reviewed and node provenance survives fan-out", async () => {
  const jev = new MockJev([(req) => Object.fromEntries(Object.keys(req.questions).map(k => [k, k.endsWith("applicable") ? 0.21 : 0.01]))]);
  const provider = new MockLLM([(args: any) => args.jsonSchema?.name === "eval_custom_metric"
    ? JSON.stringify({ verdict: "unknown", reason: "The call never reached a hold.", technical_reason: "no hold evidence" })
    : defaultJudgeResponder(args.system)!]);
  const spec = { name: "metric:hold", display_name: "Hold", scope: "node" as const, body: "Fail when held without warning.", output: "" };
  const v = await evaluateIngestedSession(config, events, provider, "livekit", undefined, undefined, [spec], jev);
  const row = buildExternalEvalRows(v).find(r => r.judgeName === spec.name)!;
  expect(row.verdictText).toBe("unknown");
  expect(row.tag).toBe("node-A");
  expect(row.raw.backend).toBe("llm");
  expect((row.raw.jev as any)?.candidate).toBe("review");
  expect((row.raw.jev as any)?.probability).toBe(0.21);
});

test("a custom metric Jev finds inapplicable is counted as unknown in the session log", async () => {
  const log = spyOn(console, "log");
  try {
    const spec = { name: "metric:hold", display_name: "Hold", scope: "node" as const, body: "Fail when held without warning.", output: "" };
    await evaluateIngestedSession(config, events, llm(), "livekit", undefined, undefined, [spec], new MockJev([{}], 0.01));
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[jev] judged"));
    expect(line).toContain("unknown=1");
  } finally {
    log.mockRestore();
  }
});

test("unavailable independent review retains candidates without emitting a pass", async () => {
  const provider = new MockLLM([(args: any) => ["eval_detection", "eval_custom_metric"].includes(args.jsonSchema?.name)
    ? "invalid" : defaultJudgeResponder(args.system)!]);
  const spec = { name: "metric:hold", display_name: "Hold", scope: "node" as const, body: "Hold warning", output: "" };
  const v = await evaluateIngestedSession(config, events, provider, "livekit", undefined, undefined, [spec], new MockJev([{}], 0.97));
  expect(v.conversation_metrics.voicemail_detected.available).toBe(false);
  expect(v.conversation_metrics.voicemail_detected.jev?.candidate).toBe("fail");
  const metric = v.custom_metrics![0]!;
  expect(metric.available).toBe(false);
  expect(metric.per_node).toBeUndefined();
  expect(metric.jev_node_candidates?.[0]?.jev?.candidate).toBe("fail");
  expect(buildExternalEvalRows(v).some(r => r.judgeName === spec.name || r.judgeName === "voicemail_detection")).toBe(false);
});
