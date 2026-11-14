import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";
import { defaultJudgeResponder } from "./fixtures/default-judge-responder.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
const { buildExternalEvalRows } = await import("../src/evals-engine/fan-out-rows.js");
type AgentConfig = import("../src/evals-engine/integration/session-evals.js").AgentConfig;
type StoredEvent = import("../src/evals-engine/integration/session-evals.js").StoredEvent;
type ProviderCompleteArgs = import("../src/llm/types.js").ProviderCompleteArgs;

// The price is configured on "quote" only; "confirm" carries no price of its own.
const config: AgentConfig = {
  flow_name: "plans",
  global_prompt: "You help callers choose a phone plan.",
  nodes: [
    { ref: "quote", name: "quote", instructions: "Tell the caller the Basic plan costs 49 dollars a month." },
    { ref: "confirm", name: "confirm", instructions: "Confirm the plan the caller chose." },
  ],
};

const say = (node_ref: string, role: "user" | "assistant", content: string): StoredEvent =>
  ({ type: "conversation_item_added", node_ref, item: { type: "message", role, content } });
const tool = (node_ref: string, item: NonNullable<StoredEvent["item"]>): StoredEvent =>
  ({ type: "conversation_item_added", node_ref, item });

const verdict = (hallucination: Record<string, unknown>) =>
  JSON.stringify({ unverifiable: false, unsupported_claim: "", score: 1, reason: "r", technical_reason: "t", ...hallucination });

async function judge(events: StoredEvent[], node: string, answer: string) {
  const calls: ProviderCompleteArgs[] = [];
  const llm = new MockLLM([(args) => {
    calls.push(args);
    if (args.system.includes("fabricated information") && JSON.parse(args.user).target_node_uuid === node) return answer;
    return defaultJudgeResponder(args.system) ?? "{}";
  }]);
  const verdicts = await evaluateIngestedSession(config, events, llm, "livekit");
  const call = calls.find((c) => c.system.includes("fabricated information") && JSON.parse(c.user).target_node_uuid === node)!;
  const row = buildExternalEvalRows(verdicts).find((r) => r.judgeName === "hallucination" && r.tag === node)!;
  return { calls, system: call.system, payload: JSON.parse(call.user), jsonSchema: call.jsonSchema, row };
}

describe("hallucination grounding", () => {
  test("an invented price the node repeats is not grounded by its own repetition", async () => {
    const claim = "The Premium plan is 79 dollars a month.";
    const { system, payload, row } = await judge([
      say("confirm", "assistant", claim),
      say("confirm", "user", "79?"),
      say("confirm", "assistant", "Yes, 79 dollars a month for Premium."),
    ], "confirm", verdict({ hallucinated: true, unsupported_claim: claim, score: 0.2 }));

    expect(payload.node_transcript).toContain(claim);
    expect(payload.node_transcript).toContain("Yes, 79 dollars a month for Premium.");
    expect(payload.conversation_history).not.toContain("79 dollars");
    expect(system).toContain("This node's own Agent lines (node_transcript) are the claims under judgement and never ground one another");
    expect(system).toContain("it does not also have to contradict anything");
    expect([row.passed, row.verdictText]).toEqual([false, undefined]);
  });

  test("restating a fact an earlier node said is grounded by that node", async () => {
    const { system, payload, row } = await judge([
      say("quote", "assistant", "The Basic plan is 49 dollars a month."),
      say("quote", "user", "Okay, Basic."),
      say("confirm", "assistant", "Great, Basic at 49 dollars a month it is."),
    ], "confirm", verdict({ hallucinated: false }));

    expect(payload.node_prompt).not.toContain("49");
    expect(payload.node_transcript).not.toContain("The Basic plan is 49 dollars a month.");
    expect(payload.conversation_history).toMatch(/node quote\] context only\nAgent: The Basic plan is 49 dollars a month\./);
    expect(system).toContain("Agent lines spoken in OTHER nodes — conversation_history events marked `context only`");
    expect([row.passed, row.verdictText]).toEqual([true, undefined]);
  });

  const lookup = { type: "function_call", name: "lookup_order", arguments: { order_id: "42" } };
  for (const [name, result] of [
    ["empty", [tool("quote", { type: "function_call_output", name: "lookup_order", output: "" })]],
    ["missing", []],
  ] as const) {
    test(`a claim resting on a tool call with a ${name} result is unknown, not a fail`, async () => {
      const claim = "Your order shipped on March 3.";
      const { system, payload, jsonSchema, row } = await judge([
        say("quote", "user", "Has my order shipped?"),
        tool("quote", lookup),
        ...result,
        say("quote", "assistant", claim),
      ], "quote", verdict({ hallucinated: false, unverifiable: true, unsupported_claim: claim, score: 0.5 }));

      expect(payload.node_transcript).toContain("Tool_Call: lookup_order");
      expect(payload.node_transcript.includes("Tool_Result: lookup_order -> \n")).toBe(name === "empty");
      expect(system).toContain("MISSING TOOL EVIDENCE");
      expect(system).toContain("Set unverifiable=true and hallucinated=false");
      expect((jsonSchema?.schema as { required: string[] }).required).toContain("unverifiable");
      expect([row.passed, row.verdictText]).toEqual([false, "unknown"]);
      expect(row.raw).toMatchObject({ unverifiable: true, unsupported_claim: claim });
    });
  }

  test("a named fabrication stays a fail when another claim in the node is unverifiable", async () => {
    const claim = "Basic is 79 dollars a month.";
    const { row } = await judge([
      say("quote", "user", "How much is Basic, and has order 42 shipped?"),
      say("quote", "assistant", claim),
      tool("quote", lookup),
      say("quote", "assistant", "Your order shipped on March 3."),
    ], "quote", verdict({ hallucinated: true, unverifiable: true, unsupported_claim: claim, score: 0.2 }));

    expect([row.passed, row.verdictText]).toEqual([false, undefined]);
    expect(row.raw).toMatchObject({ hallucinated: true, unsupported_claim: claim });
    expect(row.raw.unverifiable).toBeUndefined();
  });

  test("a non-English claim is quoted verbatim, exempt from the English-only output rule", async () => {
    const claim = "El plan Premium cuesta 79 euros al mes.";
    const { calls, system, row } = await judge([say("confirm", "assistant", claim)], "confirm",
      verdict({ hallucinated: true, unsupported_claim: claim, score: 0.2 }));

    expect(system).toContain("Exception: copy unsupported_claim verbatim");
    expect(system.indexOf("Exception: copy unsupported_claim")).toBeGreaterThan(system.indexOf("OUTPUT LANGUAGE:"));
    const loop = calls.find((c) => c.system.includes("repeat its own previous messages"))!;
    expect(loop.system).toContain("OUTPUT LANGUAGE:");
    expect(loop.system).not.toContain("unsupported_claim");
    expect([row.passed, row.verdictText]).toEqual([false, undefined]);
    expect(row.raw.unsupported_claim).toBe(claim);
  });
});
