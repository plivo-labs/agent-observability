import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => ({
  ...TEST_JUDGE_CONFIG_MODULE,
  config: { ...TEST_JUDGE_CONFIG_MODULE.config, JEV_LAYOUT: "shared", JEV_NODE_AUTO_PASS: "all" },
}));

const { MockLLM } = await import("../src/llm/index.js");
const { MockJev } = await import("../src/jev/mock.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
type AgentConfig = import("../src/evals-engine/integration/session-evals.js").AgentConfig;
type StoredEvent = import("../src/evals-engine/integration/session-evals.js").StoredEvent;

const config: AgentConfig = {
  flow_name: "orders",
  global_prompt: "You are an orders agent.",
  nodes: [
    { ref: "node-A", name: "collect_order", instructions: "Shared rules.\n\nAsk for the order id.",
      intents: [{ name: "provide_order", description: "the caller states their id", tool: "handoff_order" }],
      variables: [{ name: "order_id", rule: "Record the id.", tool: "record_order_id" }] },
    { ref: "node-B", name: "confirm", instructions: "Shared rules.\n\nConfirm the id." },
  ],
};
const say = (node_ref: string, role: string, content: string): StoredEvent => ({ type: "conversation_item_added", node_ref, item: { type: "message", role, content } });
const events: StoredEvent[] = [
  say("node-A", "assistant", "What is your order id?"), say("node-A", "user", "It is 42."),
  say("node-B", "assistant", "So that is 42?"), say("node-B", "user", "Yes."),
];
const llm = () => new MockLLM([(args: any) => defaultJudgeResponder(args.system as string) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" })]);

describe("JEV_LAYOUT=shared", () => {
  test("a two-node session asks Jev twice and its verdicts record the layout", async () => {
    const jev = new MockJev([{}], 0.02);
    const verdicts = await evaluateIngestedSession(config, events, llm(), "livekit", undefined, undefined, [], jev as any);
    expect(jev.calls.map((c) => c.key).sort()).toEqual(["c", "s0"]);
    const loop = verdicts.node_evaluations[1]!.node_loop;
    expect(loop.backend).toBe("jev");
    expect(loop.jev?.layout).toBe("shared-state-v1");
    expect(verdicts.node_evaluations[0]!.hallucination.jev?.layout).toBe("shared-state-v1");
  });
});
