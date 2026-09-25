import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { adherenceNodePayload, nodePayload } = await import("../src/evals-engine/judges/node-judge-payload.js");
const { INSTRUCTION_ADHERENCE } = await import("../src/evals-engine/judges/instructions.js");
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "screen",
  node_name: "contact_screening",
  node_prompt: "Confirm you are speaking with the target contact, then route.",
  available_intents: [],
  chosen_intent: "",
  required_variables: [],
  turns: [{ node_uuid: "screen", user: "Hello?", agent: "Is this Laure?", intent: "" }, { node_uuid: "screen", user: "Yeah.", agent: "", intent: "" }],
  turn_count: 2,
  ...over,
});
const mainNode = (): NodeEvalInput => node({
  node_uuid: "main", node_name: "quick_quote",
  node_prompt: "Confirm the move details and offer a specialist.",
  turns: [{ node_uuid: "main", user: "", agent: "I see this is a three bedroom from Redding. Is that correct?", intent: "" }],
  turn_count: 1,
});
const ctx = (nodes: NodeEvalInput[]): ConversationInput => ({
  flow_name: "movers", global_prompt: "", nodes, goals: [],
  full_transcript: "User: Hello?\nAgent: Is this Laure?\nUser: Yeah.\nAgent: I see this is a three bedroom from Redding. Is that correct?",
});

describe("adherence payload: segment scope", () => {
  test("names the node the conversation moved to after this segment", () => {
    const screen = node(); const main = mainNode();
    const p = adherenceNodePayload(screen, ctx([screen, main]));
    expect(p.next_node).toBe("quick_quote");
  });

  test("is null when this segment ends the conversation", () => {
    const screen = node(); const main = mainNode();
    expect(adherenceNodePayload(main, ctx([screen, main])).next_node).toBeNull();
    expect(adherenceNodePayload(screen, ctx([screen])).next_node).toBeNull();
  });

  test("the shared node payload is unchanged (other judges keep their surface)", () => {
    const screen = node(); const main = mainNode();
    expect("next_node" in nodePayload(screen, ctx([screen, main]))).toBe(false);
  });
});

describe("adherence prompt: segment scope rule", () => {
  test("tells the judge to score this node from node_transcript only and to read next_node as the executed handoff", () => {
    expect(INSTRUCTION_ADHERENCE).toContain("SEGMENT SCOPE");
    expect(INSTRUCTION_ADHERENCE).toContain("next_node");
    expect(INSTRUCTION_ADHERENCE).toMatch(/node_transcript is the ONLY evidence/);
  });
});
