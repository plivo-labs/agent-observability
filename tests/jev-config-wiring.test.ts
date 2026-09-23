import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

// This suite is the only one that runs the orchestrator with NON-default Jev
// env: without it, every knob the session reads could stop being wired and the
// rest of the suite would stay green.
mock.module("../src/config.js", () => ({
  ...TEST_JUDGE_CONFIG_MODULE,
  config: {
    ...TEST_JUDGE_CONFIG_MODULE.config,
    JEV_JUDGES: "node_loop, halucination ,voicemail_detection",
    JEV_GATES: JSON.stringify({ node_loop: { pass_below: -1, fail_above: 0.5 } }),
    JEV_CUSTOM_METRICS: "on",
    JEV_STATE_TOKEN_BUDGET: 900,
  },
}));

const { MockLLM } = await import("../src/llm/index.js");
const { MockJev } = await import("../src/jev/mock.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
type AgentConfig = import("../src/evals-engine/integration/session-evals.js").AgentConfig;
type StoredEvent = import("../src/evals-engine/integration/session-evals.js").StoredEvent;
type CustomJudgeSpec = import("../src/evals-engine/judges/custom-metric.js").CustomJudgeSpec;

const config: AgentConfig = {
  flow_name: "orders",
  global_prompt: "You are an orders agent.",
  nodes: [{
    ref: "node-A", name: "collect_order", instructions: "Ask for the order id.",
    intents: [{ name: "provide_order", description: "the caller states their id", tool: "handoff_order" }],
    variables: [{ name: "order_id", rule: "Record the id.", tool: "record_order_id" }],
  }],
};
const events: StoredEvent[] = [
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "system", content: "# Initial Context\nLead is Ada in Testville, Statia. " + "filler ".repeat(200) } },
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "What is your order id?" } },
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "user", content: "It is 42." } },
];
/** Long enough that the node state, which carries the whole conversation plus
 *  the config, cannot fit the 900-token budget this suite pins. */
const longEvents: StoredEvent[] = [
  ...events,
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: `Let me read that back. ${"detail ".repeat(900)}` } },
];
const llm = () => new MockLLM([(args: any) => defaultJudgeResponder(args.system as string) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" })]);

describe("JEV_JUDGES and JEV_GATES are read at judge time", () => {
  test("only the listed judges are asked, and the gate override decides them", async () => {
    const jev = new MockJev([{}], 0.6);
    const verdicts = await evaluateIngestedSession(config, events, llm(), "livekit", undefined, undefined, [], jev as any);
    const asked = jev.calls.flatMap((c) => Object.keys(c.questions));
    expect(asked.some((k) => k.endsWith("node_loop"))).toBe(true);
    expect(asked.some((k) => k.includes("voicemail"))).toBe(true);
    // a typo in the list leaves that judge on the LLM, and the unlisted ones too
    expect(asked.some((k) => k.includes("h1_completion"))).toBe(false);
    expect(asked.some((k) => k.includes("intent"))).toBe(false);
    expect(asked.some((k) => k.includes("bot_detection"))).toBe(false);

    // the override's fail_above of 0.5 turns a 0.6 into a fail, where the
    // shipped gate would have reviewed it
    expect(verdicts.node_evaluations[0]!.node_loop.loop_detected).toBe(true);
    expect(verdicts.node_evaluations[0]!.node_loop.backend).toBe("jev");
    expect(verdicts.node_evaluations[0]!.hallucination.backend).toBe("llm");
  });

  test("JEV_STATE_TOKEN_BUDGET drops the requests it cannot fit, and those axes go to the LLM", async () => {
    const jev = new MockJev([{}], 0.02);
    const verdicts = await evaluateIngestedSession(config, longEvents, llm(), "livekit", undefined, undefined, [], jev as any);
    // nothing fits 900 tokens, so nothing is sent and every axis is judged by
    // the LLM exactly as it would be with Jev switched off
    expect(jev.calls).toHaveLength(0);
    expect(verdicts.node_evaluations[0]!.node_loop.backend).toBe("llm");
    expect(verdicts.conversation_metrics.voicemail_detected.available).toBe(true);
    expect(verdicts.conversation_metrics.voicemail_detected.confidence).toBeUndefined();
  });
});

describe("JEV_CUSTOM_METRICS=on", () => {
  const spec = (over: Partial<CustomJudgeSpec> = {}): CustomJudgeSpec => ({
    name: "metric:greeting", display_name: "Greeting", scope: "node",
    body: "Fail if the agent never greeted the caller.", output: "", ...over,
  });

  test("a node-scope metric is decided by Jev and rolls up with its provenance", async () => {
    const jev = new MockJev([(req) => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) out[key] = key.endsWith(".applicable") ? 0.95 : 0.93;
      return out;
    }]);
    const verdicts = await evaluateIngestedSession(config, events, llm(), "livekit", undefined, undefined, [spec()], jev as any);
    const metric = verdicts.custom_metrics![0]!;
    expect(metric.verdict).toBe("fail");
    expect(metric.backend).toBe("jev");
    expect(metric.per_node).toHaveLength(1);
  });

  test("a broken custom judge is contained: unknown + unavailable, the rest of the session still judged", async () => {
    // Jev decides nothing for the metric, so it falls to the LLM — which
    // returns a shape the custom schema rejects on every attempt.
    const jev = new MockJev([(req) => Object.fromEntries(Object.keys(req.questions).map((k) => [k, k.endsWith(".applicable") ? 0.95 : 0.5]))]);
    const provider = new MockLLM([(args: any) => {
      const system = args.system as string;
      if (system.includes("Fail if the agent never greeted")) return "not json";
      return defaultJudgeResponder(system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
    }]);
    const verdicts = await evaluateIngestedSession(config, events, provider, "livekit", undefined, undefined, [spec()], jev as any);
    const metric = verdicts.custom_metrics![0]!;
    expect(metric.verdict).toBe("unknown");
    expect(metric.available).toBe(false);
    expect(verdicts.node_evaluations).toHaveLength(1);
    expect(verdicts.conversation_metrics.voicemail_detected.available).toBe(true);
  });
});
