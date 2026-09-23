import { describe, test, expect } from "bun:test";
import { keyTokens, configExcerpts, residualClaims, buildHallucinationState } from "../src/jev/hallucination-grounding.js";
import { estimateJevTokens } from "../src/jev/tokens.js";

type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1",
  node_name: "outreach",
  node_prompt: "Introduce yourself as Ada from the moving service.",
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
    const toks = keyTokens("Agent: Hi Ada, your move to Exampleton is 1 2 5 1 3 2 7 on the 30th.");
    expect(toks).toContain("ada");
    expect(toks).toContain("exampleton");
    expect(toks).toContain("1251327");
    expect(toks).not.toContain("hi");
    expect(toks).not.toContain("your");
  });

  test("is deterministic and de-duplicated, in order of first appearance", () => {
    const t = keyTokens("Agent: Exampleton. Exampleton! Sampleton.");
    expect(t).toEqual(keyTokens("Agent: Exampleton. Exampleton! Sampleton."));
    expect(t.filter((x) => x === "exampleton")).toHaveLength(1);
    expect(t.indexOf("exampleton")).toBeLessThan(t.indexOf("sampleton"));
  });
});

describe("configExcerpts", () => {
  test("returns windows of config around tokens the agent spoke", () => {
    const filler = "x".repeat(4000);
    const call = ctx({ nodes: [node({ node_prompt: `${filler}\nThe unit at 1 Example Street is available.\n${filler}` })] });
    const excerpts = configExcerpts(call, ["Agent: I found 1 Example Street for you."]);
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts.join(" ")).toContain("Example Street");
    expect(excerpts.every((e) => e.length <= 500)).toBe(true);
  });

  test("the speaker label is not a spoken value, and one repeated word cannot starve the rest", () => {
    // A config that repeats a common word 150 times used to consume the whole
    // window budget, leaving the values the agent actually said ungrounded.
    const prompt = Array.from({ length: 150 }, (_, i) => `STEP ${i}: the agent must greet the caller politely.`).join("\n");
    const call = ctx({ nodes: [node({ node_prompt: prompt })], system_messages: ["# Initial Context\nLead is Ada at Example Terrace, unit 42."] });
    const excerpts = configExcerpts(call, ["Agent: Hi Ada, I have you at Example Terrace unit 42."]).join(" ");
    expect(excerpts).toContain("Ada");
    expect(excerpts).toContain("Example Terrace");
  });

  test("searches every node's prompt and the runtime system messages, not just this node", () => {
    const call = ctx({
      nodes: [node({ node_prompt: "Greet the caller." }), node({ node_uuid: "n2", node_prompt: "Voicemail path: mention Example City." })],
      system_messages: ["# Initial Context\nLead lives in Testville, Statia."],
    });
    const excerpts = configExcerpts(call, ["Agent: I see you're in Testville and we cover Example City."]).join(" ");
    expect(excerpts).toContain("Testville");
    expect(excerpts).toContain("Example City");
  });
});

describe("residualClaims", () => {
  const transcript = [
    "Agent: Hi, this is Ada about your move from Sampleton to Exampleton.",
    "User: Yes, that's right.",
    "Tool_Call: record_city({\"value\": \"exampleton\"})",
  ].join("\n");

  test("drops values grounded in config, the caller, or a tool call", () => {
    const call = ctx({ nodes: [node({ node_prompt: "You are Ada. The lead moves from Sampleton." })] });
    const claims = residualClaims(call, transcript, 5).map((c) => c.token);
    expect(claims).not.toContain("ada");
    expect(claims).not.toContain("sampleton");
    expect(claims).not.toContain("exampleton");
  });

  test("reports an ungrounded value with the line it was spoken in", () => {
    const call = ctx({ nodes: [node({ node_prompt: "You are Ada." })] });
    const claims = residualClaims(call, "Agent: Your quote is with Nowhere Movers.", 5);
    expect(claims.map((c) => c.token)).toContain("nowhere");
    expect(claims[0]!.line).toContain("Agent:");
  });

  test("grounds a state name written as its postal abbreviation, and digits ignoring spacing", () => {
    const call = ctx({ nodes: [node({ node_prompt: "Destination: Example City, TX. Callback 5550000000." })] });
    const claims = residualClaims(call, "Agent: Moving to Texas — call 5 5 5 0 0 0 0 0 0 0.", 5).map((c) => c.token);
    expect(claims).not.toContain("texas");
    expect(claims).not.toContain("5550000000");
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
    "Agent: Hi, this is Ada.",
    "Tool_Call: lookup({})",
    `Tool_Result: lookup -> ${"y".repeat(200000)}`,
  ].join("\n");

  test("clips the giant tool result but keeps every spoken line and the full node prompt", () => {
    const prompt = "P".repeat(30000);
    const { state } = buildHallucinationState(ctx(), node({ node_prompt: prompt }), transcript, 30000);
    expect(state.node_instructions_full).toBe(prompt);
    expect(state.caller_said).toEqual(["User: hello"]);
    expect(state.agent_spoken).toEqual(["Agent: Hi, this is Ada."]);
    expect(state.tool_results.every((l) => l.length <= 1500)).toBe(true);
  });

  test("sheds evidence lists, never the prompt or the agent's lines, to fit the budget", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Tool_Result: t${i} -> ${"z".repeat(1400)}`).join("\n");
    const t = `User: hi\nAgent: hello\n${many}`;
    const { state } = buildHallucinationState(ctx(), node(), t, 20_000);
    expect(estimateJevTokens(state)).toBeLessThanOrEqual(20_000);
    expect(state.tool_results).toHaveLength(12);
    expect(state.agent_spoken).toEqual(["Agent: hello"]);
    expect(state.caller_said).toEqual(["User: hi"]);
    expect(state.node_instructions_full).toBe(node().node_prompt);
  });

  test("a state that cannot fit even at the last rung keeps its tool results — the plan drops it to the LLM instead of asking blind", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Tool_Result: t${i} -> ${"z".repeat(1400)}`).join("\n");
    const { state } = buildHallucinationState(ctx(), node(), `User: hi\nAgent: hello\n${many}`, 2000);
    expect(state.tool_results).toHaveLength(4);
    expect(estimateJevTokens(state)).toBeGreaterThan(2000);
    expect(state.agent_spoken).toEqual(["Agent: hello"]);
  });
});
