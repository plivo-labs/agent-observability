import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { writeFailReasons, REASON_WRITER_SYSTEM } = await import("../src/evals-engine/judges/reason-writer.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;

const node: NodeEvalInput = {
  node_uuid: "n1", node_name: "collect", node_prompt: "Ask for the id.",
  available_intents: [], chosen_intent: "", required_variables: ["order_id"],
  extracted_variables: {}, turns: [], turn_count: 0,
};
const ctx: ConversationInput = {
  flow_name: "orders", global_prompt: "You are an orders agent.", nodes: [node], goals: [],
  full_transcript: "User: hi\nAgent: What is your order id?",
};
const axes = [
  { id: "n0:variable_extraction", judge: "variable_extraction", node_name: "collect", detail: "variables flagged: order_id (not recorded)" },
  { id: "c.low_engagement", judge: "low_engagement" },
];

describe("writeFailReasons", () => {
  test("one strict-schema call carrying the transcript once and every failing axis", async () => {
    const provider = new MockLLM([JSON.stringify({ reasons: axes.map((a) => ({ id: a.id, reason: `r ${a.id}`, technical_reason: `t ${a.id}` })) })]);
    const { reasons } = await writeFailReasons({ ctx, nodes: [{ node, nodeIndex: 0 }], axes, provider });
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.jsonSchema?.name).toBe("eval_jev_reason");
    expect(call.jsonSchema?.strict).toBe(true);
    expect(call.system).toContain(REASON_WRITER_SYSTEM);
    const sent = JSON.parse(call.user);
    expect(sent.conversation_history).toContain("What is your order id?");
    expect(sent.nodes).toHaveLength(1);
    expect(sent.defects.map((d: { id: string }) => d.id)).toEqual(["n0:variable_extraction", "c.low_engagement"]);
    expect(reasons.get("c.low_engagement")).toEqual({ reason: "r c.low_engagement", technical_reason: "t c.low_engagement" });
  });

  test("the schema has no dynamic keys — a strict gateway must be able to accept it", () => {
    const provider = new MockLLM(["{}"]);
    return writeFailReasons({ ctx, nodes: [], axes, provider }).then(() => {
      const schema = provider.calls[0]!.jsonSchema!.schema as any;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.reasons.type).toBe("array");
      expect(schema.properties.reasons.items.required).toEqual(["id", "reason", "technical_reason"]);
      expect(schema.properties.reasons.items.additionalProperties).toBe(false);
    });
  });

  test("text for an axis we did not ask about, or empty text, is dropped", async () => {
    const provider = new MockLLM([JSON.stringify({
      reasons: [
        { id: "n0:variable_extraction", reason: "  ", technical_reason: "  " },
        { id: "someone-elses-axis", reason: "nope", technical_reason: "nope" },
        { id: "c.low_engagement", reason: "kept", technical_reason: "" },
      ],
    })]);
    const { reasons } = await writeFailReasons({ ctx, nodes: [], axes, provider });
    expect([...reasons.keys()]).toEqual(["c.low_engagement"]);
  });
});
