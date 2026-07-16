import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG } from "./fixtures/judge-config.js";

// Regression guard for the benchmark-round-2 judge calibrations (2026-07-12
// AO-vs-legacy ground-truth audit). Each rule below fixed a verified over-fire
// cluster; losing one from a prompt re-edit silently reintroduces that cluster.
// Content assertions are on the DISTINCTIVE calibration phrases, not full text —
// prompts may be reworded around them.

// Mock config so importing the llm module (via the judges) doesn't parse real env.
mock.module("../src/config.js", () => ({
  config: TEST_JUDGE_CONFIG,
}));

const {
  HALLUCINATION,
  systemForHallucination,
  VARIABLE_EXTRACTION,
  LOOP_DETECTION,
  INSTRUCTION_ADHERENCE,
  GOAL_EVALUATION,
} = await import("../src/evals-engine/judges/instructions.js");
const { MockLLM } = await import("../src/llm/index.js");
const { evaluateConversationMetrics } = await import("../src/evals-engine/judges/conversation-judges.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

describe("node/goal judge calibration (benchmark round-2 over-fire fixes)", () => {
  test("node_loop exempts unmarked idle re-prompts (consecutive agent turns, no user speech)", () => {
    expect(LOOP_DETECTION).toContain("[system idle prompt]");
    expect(LOOP_DETECTION).toContain("Unmarked idle scaffolding");
    expect(LOOP_DETECTION).toContain("NO user speech between");
    // The exemption must stay scoped: substantive repetition into silence is still a loop.
    expect(LOOP_DETECTION).toContain("SUBSTANTIVE task content");
  });

  test("adherence: silent recording tools, interrupted turns, offered-transfer semantics", () => {
    expect(INSTRUCTION_ADHERENCE).toContain("SILENT RECORDING TOOLS");
    expect(INSTRUCTION_ADHERENCE).toContain("without spoken acknowledgment");
    expect(INSTRUCTION_ADHERENCE).toContain("INTERRUPTED TURNS");
    expect(INSTRUCTION_ADHERENCE).toContain("UNREACHABLE, not missed");
    expect(INSTRUCTION_ADHERENCE).toContain("TRANSFER SEMANTICS");
    expect(INSTRUCTION_ADHERENCE).toContain("caller-initiated requests");
    // Idle boilerplate must not be counted for quality (multi_question etc.).
    expect(INSTRUCTION_ADHERENCE).toContain("[system idle prompt]");
  });

  test("hallucination: user echo is grounded; hint lines are aids not arbiters", () => {
    expect(HALLUCINATION).toContain("USER ECHO IS GROUNDED");
    expect(HALLUCINATION).toContain("HINT LINES ARE AIDS, NOT ARBITERS");
    expect(HALLUCINATION).toContain("the user's words win");
  });

  test("hallucination: only caller-facing agent speech can become an accusation target", () => {
    const prompt = systemForHallucination();
    expect(prompt).toContain("CANDIDATE CLAIMS — SPOKEN AGENT LINES ONLY");
    expect(prompt).toContain("Only text from actual `Agent:` speech lines");
    expect(prompt).toContain("NEVER accusation targets");
    expect(prompt).toContain("remain valid grounding EVIDENCE");
    expect(prompt).toContain("Tool_Call:");
    expect(prompt).toContain("Tool_Result:");
    expect(prompt).toContain("System_Note:");
    expect(prompt).toContain("Agent_Handoff:");
  });

  test("hallucination: forbidden behavior and stored values stay in their own judges", () => {
    const prompt = systemForHallucination();
    expect(prompt).toContain("SCOPE — OTHER JUDGES");
    expect(prompt).toContain("forbidden, premature, or unauthorized");
    expect(prompt).toContain("not whether the agent was allowed to say it");
    expect(prompt).toContain("Wrong or invented values that appear only in stored data");
    expect(prompt).toContain("plausibly supports the mistaken reading");
    expect(prompt).toContain("Applying a configured criterion to a caller-proposed scenario");
    expect(prompt).toContain("must not re-grade whether the instructions allowed");
    expect(prompt).toContain("A new specific property of the scenario");
  });

  test("hallucination: imperatives, reassurance, and placeholder artifacts are not facts", () => {
    const prompt = systemForHallucination();
    expect(prompt).toContain("IMPERATIVES, recommendations, and suggestions");
    expect(prompt).toContain("assert no outcome");
    expect(prompt).toContain("Generic reassurance carrying no specific factual detail");
    expect(prompt).toContain("Quote the agent's exact words");
    expect(prompt).toContain("<fill_your_data>");
    expect(prompt).toContain("%order_id%");
    expect(prompt).toContain("bare slot identifiers");
    expect(prompt).toContain("Do not judge whether an imperative's advice is correct");
    expect(prompt).toContain("Do not search for proof that the advice will work");
  });

  test("hallucination: runtime normalization and successful actions ground equivalent speech", () => {
    const prompt = systemForHallucination();
    expect(prompt).toContain("country-code prefix, SIP wrapper, spaces, or punctuation");
    expect(prompt).toContain("definite promise to perform a concrete, externally verifiable action");
    expect(prompt).toContain("asserts that the capability/path exists");
    expect(prompt).toContain("no instruction, tool/handoff, action result, or other valid source");
    expect(prompt).toContain("A successful non-recording action result");
    expect(prompt).toContain("A bookkeeping record_* call alone");
  });

  test("hallucination: a failure must identify the spoken claim and complete the evidence search", () => {
    const prompt = systemForHallucination();
    expect(prompt).toContain("EVIDENCE SEARCH — REQUIRED BEFORE FAILING");
    expect(prompt).toContain("node_prompt and global_prompt can be long");
    expect(prompt).toContain("# Initial Context");
    expect(prompt).toContain("Search the node instructions");
    expect(prompt).toContain("HARD GROUNDING GATE");
    expect(prompt).toContain("MUST NOT produce hallucinated=true");
    expect(prompt).toContain("did not need to be spoken to, explained to, or confirmed by the caller");
    expect(prompt).toContain("Do not acknowledge that a source grounds a claim and then fail it");
    expect(prompt).toContain("Unsupported spoken claim:");
    expect(prompt).toContain("Sources checked:");
    expect(prompt).toContain("If either part is missing, return hallucinated=false");
  });

  test("variable extraction: spoken-date equivalence both ways; empty set is not a free pass", () => {
    expect(VARIABLE_EXTRACTION).toContain("USER'S OWN WORDS");
    expect(VARIABLE_EXTRACTION).toContain("parsing aids, not arbiters");
    expect(VARIABLE_EXTRACTION).toContain("EMPTY extraction set is not automatically a pass");
  });

  test("goal evaluation: a conditional goal whose trigger never occurred is not a failure", () => {
    expect(GOAL_EVALUATION).toContain("NOT APPLICABLE is NOT a failure");
    expect(GOAL_EVALUATION).toContain("achieved=true");
  });
});

describe("conversation judge calibration (system prompts as sent to the LLM)", () => {
  const ctx = (): ConversationInput => ({
    flow_name: "outreach",
    global_prompt: "You are an outreach agent.",
    nodes: [],
    goals: [],
    full_transcript: "User: hello?\nAgent: Hi, this is Acme.\nUser: ok sure",
  });

  test("bot_detected targets the counterparty; agent's own lines are never evidence", async () => {
    const systems: string[] = [];
    const llm = new MockLLM([
      (args: { system?: string }) => {
        const s = args.system ?? "";
        systems.push(s);
        if (s.includes("Classify the user's sentiment")) return JSON.stringify({ sentiment: "positive", reason: "r", technical_reason: "t" });
        if (s.includes("speech-to-text quality")) return JSON.stringify({ error_count: 0, recovered_count: 0, reason: "r", technical_reason: "t" });
        return JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
      },
    ]);
    await evaluateConversationMetrics(ctx(), llm);

    const bot = systems.find((s) => s.includes("automated system or AI"));
    expect(bot).toBeDefined();
    expect(bot!).toContain("NEVER evidence");
    expect(bot!).toContain('Judge ONLY the "User:" lines');
    expect(bot!).toContain("suspicious human, not a bot");

    const sentiment = systems.find((s) => s.includes("Classify the user's sentiment"));
    expect(sentiment).toBeDefined();
    expect(sentiment!).toContain("calm decline");
    expect(sentiment!).toContain("polite factual correction");
  });
});
