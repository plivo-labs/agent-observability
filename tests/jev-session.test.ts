import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { MockJev } = await import("../src/jev/mock.js");
const { JevError, JEV_OVERFLOW } = await import("../src/jev/types.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
const { REASON_WRITER_SYSTEM } = await import("../src/evals-engine/judges/reason-writer.js");
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
      const asked = JSON.parse(args.user as string).defects as Array<{ id: string }>;
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

describe("confident Jev verdicts", () => {
  test("all-clean: no judge call at all beyond sentiment and STT", async () => {
    const jev = new MockJev([{}], 0.01);
    const { v, provider } = await run(jev);
    // adherence never auto-passes by design, and low engagement is not on the
    // Jev path by default — those two plus sentiment and STT are all that remain
    expect(labelsOf(provider)).toEqual(["eval_detection", "eval_instruction", "eval_sentiment", "eval_stt"]);
    expect(jev.calls.map((c) => c.key).sort()).toEqual(["c", "h0", "n0", "v0.0"]);

    const node = v.node_evaluations[0]!;
    expect(node.node_loop.loop_detected).toBe(false);
    expect(node.node_loop.backend).toBe("jev");
    expect(node.node_loop.confidence).toBe(0.01);
    expect(node.node_loop.jev_model).toBe("jev-mock");
    expect(node.node_loop.reason).toContain("No defect found");
    expect(node.variable_extraction.required_variables).toEqual(["order_id"]);
    expect(node.intent_identification.score).toBe(1);
    // adherence never auto-passes, so it is the one axis the LLM still judged
    expect(node.instructions_adherence.backend).toBe("llm");
    expect(v.conversation_metrics.voicemail_detected.backend).toBe("jev");
    expect(v.conversation_metrics.user_sentiment.available).toBe(true);
  });

  test("confident fails take ONE reason call for the whole session", async () => {
    const jev = new MockJev([(req) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key.includes("node_loop") || key.includes("instructions_adherence") ? 0.97 : 0.01;
      return out;
    }]);
    const { v, provider } = await run(jev);
    const reasonCalls = provider.calls.filter((c) => (c.system as string).includes("calibrated classifier"));
    expect(reasonCalls).toHaveLength(1);
    expect(reasonCalls[0]!.jsonSchema?.name).toBe("eval_jev_reason");
    expect(reasonCalls[0]!.system).toContain(REASON_WRITER_SYSTEM.slice(0, 40));
    // the transcript rides along once, not once per failing axis
    expect((reasonCalls[0]!.user.match(/What is your order id\?/g) ?? []).length).toBe(1);

    const node = v.node_evaluations[0]!;
    expect(node.node_loop.loop_detected).toBe(true);
    expect(node.node_loop.reason).toBe("why n0:node_loop");
    expect(node.node_loop.technical_reason).toContain("jev 0.97");
    expect(node.instructions_adherence.adherence_passed).toBe(false);
    expect(node.instructions_adherence.objective_progress).toBeNull();
  });

  test("the reason call carries only the nodes a defect was found on", async () => {
    const twoNodeConfig = {
      ...config,
      nodes: [config.nodes![0]!, { ref: "node-B", name: "wrap_up", instructions: "Thank the caller and close.", intents: [], variables: [] }],
    };
    const twoNodeEvents = [
      ...events,
      { type: "conversation_item_added", node_ref: "node-B", item: { type: "message", role: "assistant", content: "Thanks, goodbye." } },
    ] as StoredEvent[];
    const jev = new MockJev([(req) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key.startsWith("n1.") && key.includes("node_loop") ? 0.97 : 0.01;
      return out;
    }]);
    const provider = llm();
    await evaluateIngestedSession(twoNodeConfig, twoNodeEvents, provider, "livekit", undefined, undefined, [], jev as any);
    const reasonCall = provider.calls.find((c) => (c.system as string).includes("calibrated classifier"))!;
    const sent = JSON.parse(reasonCall.user);
    expect(sent.nodes.map((n: { node_index: number }) => n.node_index)).toEqual([1]);
    expect(sent.defects.map((d: { id: string }) => d.id)).toEqual(["n1:node_loop"]);
  });

  test("a fired variable question becomes a named defect, filed by whether it was recorded", async () => {
    const jev = new MockJev([(req) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key.startsWith("v0.") ? 0.96 : 0.01;
      return out;
    }]);
    const { v } = await run(jev);
    const ve = v.node_evaluations[0]!.variable_extraction;
    expect(ve.extraction_successful).toBe(false);
    expect(ve.incorrect_variables).toEqual(["order_id"]);
    expect(ve.missing_variables).toEqual([]);
    expect(ve.required_variables).toEqual(["order_id"]);
  });

  test("a Jev-decided voicemail still suppresses user_never_spoke and the ladder below it", async () => {
    const jev = new MockJev([(req) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key === "c.voicemail_detection" || key === "c.bot_detection" ? 0.95 : 0.01;
      return out;
    }]);
    const { v } = await run(jev);
    expect(v.conversation_metrics.voicemail_detected.detected).toBe(true);
    expect(v.conversation_metrics.voicemail_detected.backend).toBe("jev");
    // bot fired too but the ladder keeps voicemail: the suppressed axis is a
    // CODE decision and must not carry Jev's probability as its confidence
    expect(v.conversation_metrics.bot_detected.detected).toBe(false);
    expect(v.conversation_metrics.bot_detected.backend).toBe("code");
    expect(v.conversation_metrics.bot_detected.confidence).toBeUndefined();
    expect(v.conversation_metrics.user_never_spoke.available).toBe(false);
    expect(v.conversation_metrics.conversation_status.status).toBe("voicemail_detected");
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
    expect(v.node_evaluations[0]!.hallucination.backend).toBe("jev");
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

  test("a transient reason-writer failure retries the session instead of stamping a templated reason", async () => {
    const provider = new MockLLM([(args: any) => {
      const system = args.system as string;
      if (system.includes("calibrated classifier")) throw new Error("429 rate limit exceeded");
      return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
    }]);
    const jev = new MockJev([(req) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key.includes("node_loop") ? 0.97 : 0.01;
      return out;
    }]);
    await expect(run(jev, provider)).rejects.toThrow(/429/);
  });

  test("the reason writer failing keeps the verdict with a plain explanation", async () => {
    const provider = new MockLLM([(args: any) => {
      const system = args.system as string;
      if (system.includes("calibrated classifier")) return "not json at all";
      return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
    }]);
    const jev = new MockJev([(req) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key.includes("node_loop") ? 0.97 : 0.01;
      return out;
    }]);
    const { v } = await run(jev, provider);
    const loop = v.node_evaluations[0]!.node_loop;
    expect(loop.loop_detected).toBe(true);
    expect(loop.reason).toContain("explanation unavailable");
    expect(loop.confidence).toBe(0.97);
  });
});

describe("failures never escape as unhandled rejections", () => {
  test("a detection judge throwing transiently rejects the session, with sentiment and STT handled", async () => {
    const provider = new MockLLM([(args: any) => {
      const system = args.system as string;
      if (system.includes("Detect low engagement")) throw new Error("429 rate limit exceeded");
      return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
    }]);
    // Jev answers the detections it owns; low engagement is the LLM's, and it throws.
    const jev = new MockJev([{}], 0.01);
    await expect(run(jev, provider)).rejects.toThrow(/429/);
    // sentiment and STT were started in the same batch, so their results were
    // consumed rather than left dangling
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
    // low engagement stays on the LLM by default
    expect(v.conversation_metrics.low_engagement.backend).toBe("llm");
    const asked = jev.calls.flatMap((c) => Object.keys(c.questions));
    expect(asked.some((k) => k.includes("voicemail"))).toBe(false);
  });
});
