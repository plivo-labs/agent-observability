import { describe, test, expect } from "bun:test";
import { keyTokens, configExcerpts, residualClaims, buildHallucinationState } from "../src/jev/hallucination-grounding.js";

type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1",
  node_name: "outreach",
  node_prompt: "Introduce yourself as Kylie from the moving service.",
  available_intents: [],
  chosen_intent: "",
  required_variables: [],
  extracted_variables: {},
  turns: [],
  turn_count: 0,
  ...over,
});

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "moving",
  global_prompt: "You are a helpful moving assistant.",
  nodes: [node()],
  goals: [],
  full_transcript: "",
  ...over,
});

describe("keyTokens", () => {
  test("keeps capitalized words and digit runs, drops stop words and short tokens", () => {
    const toks = keyTokens("Agent: Hi Chanel, your move to Austin is 1 2 5 1 3 2 7 on the 30th.");
    expect(toks).toContain("chanel");
    expect(toks).toContain("austin");
    expect(toks).toContain("1251327");
    expect(toks).not.toContain("hi");
    expect(toks).not.toContain("your");
  });

  test("is deterministic and de-duplicated, in order of first appearance", () => {
    const t = keyTokens("Agent: Austin. Austin! Dallas.");
    expect(t).toEqual(keyTokens("Agent: Austin. Austin! Dallas."));
    expect(t.filter((x) => x === "austin")).toHaveLength(1);
    expect(t.indexOf("austin")).toBeLessThan(t.indexOf("dallas"));
  });
});

describe("configExcerpts", () => {
  test("returns windows of config around tokens the agent spoke", () => {
    const filler = "x".repeat(4000);
    const call = ctx({ nodes: [node({ node_prompt: `${filler}\nThe property at 1107 Rotterdam Street is available.\n${filler}` })] });
    const excerpts = configExcerpts(call, ["Agent: I found 1107 Rotterdam Street for you."]);
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts.join(" ")).toContain("Rotterdam");
    expect(excerpts.every((e) => e.length <= 500)).toBe(true);
  });

  test("searches every node's prompt and the runtime system messages, not just this node", () => {
    const call = ctx({
      nodes: [node({ node_prompt: "Greet the caller." }), node({ node_uuid: "n2", node_prompt: "Voicemail path: mention San Diego." })],
      system_messages: ["# Initial Context\nLead lives in Pontiac, Michigan."],
    });
    const excerpts = configExcerpts(call, ["Agent: I see you're in Pontiac and we cover San Diego."]).join(" ");
    expect(excerpts).toContain("Pontiac");
    expect(excerpts).toContain("San Diego");
  });
});

describe("residualClaims", () => {
  const transcript = [
    "Agent: Hi, this is Kylie about your move from Baltimore to Austin.",
    "User: Yes, that's right.",
    "Tool_Call: record_city({\"value\": \"austin\"})",
  ].join("\n");

  test("drops values grounded in config, the caller, or a tool call", () => {
    const call = ctx({ nodes: [node({ node_prompt: "You are Kylie. The lead moves from Baltimore." })] });
    const claims = residualClaims(call, transcript, 5).map((c) => c.token);
    expect(claims).not.toContain("kylie");
    expect(claims).not.toContain("baltimore");
    expect(claims).not.toContain("austin");
  });

  test("reports an ungrounded value with the line it was spoken in", () => {
    const call = ctx({ nodes: [node({ node_prompt: "You are Kylie." })] });
    const claims = residualClaims(call, "Agent: Your quote is with Zephyrhills Movers.", 5);
    expect(claims.map((c) => c.token)).toContain("zephyrhills");
    expect(claims[0]!.line).toContain("Agent:");
  });

  test("grounds a state name written as its postal abbreviation, and digits ignoring spacing", () => {
    const call = ctx({ nodes: [node({ node_prompt: "Destination: Austin, TX. Callback 9004805311." })] });
    const claims = residualClaims(call, "Agent: Moving to Texas — call 9 0 0 4 8 0 5 3 1 1.", 5).map((c) => c.token);
    expect(claims).not.toContain("texas");
    expect(claims).not.toContain("9004805311");
  });

  test("honours the cap", () => {
    const call = ctx({ nodes: [node({ node_prompt: "" })] });
    const line = "Agent: Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel.";
    expect(residualClaims(call, line, 3)).toHaveLength(3);
  });
});

describe("buildHallucinationState", () => {
  const transcript = [
    "User: hello",
    "Agent: Hi, this is Kylie.",
    "Tool_Call: lookup({})",
    `Tool_Result: lookup -> ${"y".repeat(200000)}`,
  ].join("\n");

  test("clips the giant tool result but keeps every spoken line and the full node prompt", () => {
    const prompt = "P".repeat(30000);
    const { state } = buildHallucinationState(ctx(), node({ node_prompt: prompt }), transcript, 30000);
    expect(state.node_instructions_full).toBe(prompt);
    expect(state.caller_said).toEqual(["User: hello"]);
    expect(state.agent_spoken).toEqual(["Agent: Hi, this is Kylie."]);
    expect(state.tool_results.every((l) => l.length <= 1500)).toBe(true);
  });

  test("sheds evidence lists, never the prompt or the agent's lines, to fit the budget", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Tool_Result: t${i} -> ${"z".repeat(1400)}`).join("\n");
    const t = `User: hi\nAgent: hello\n${many}`;
    const { state } = buildHallucinationState(ctx(), node(), t, 2000);
    expect(state.tool_results.length).toBeLessThanOrEqual(12);
    expect(state.agent_spoken).toEqual(["Agent: hello"]);
    expect(state.node_instructions_full).toBe(node().node_prompt);
  });
});
