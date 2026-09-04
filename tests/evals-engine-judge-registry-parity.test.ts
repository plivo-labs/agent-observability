import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

// Mock config so importing the llm module (via the judges) doesn't parse real env.
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

// The parity gate for the judge registry: the catalogue rows that seed
// migrations/024 must reproduce the shipped prompts BYTE-IDENTICALLY, or the
// registry cutover changes judge behaviour. Full-text equality is the point —
// unlike the calibration suite, a one-character drift here must fail.
const { DEFAULT_JUDGE_ROWS } = await import("../src/evals-engine/judge-catalogue.js");
const prompts = await import("../src/evals-engine/judges/judge-prompts.js");
const instructions = await import("../src/evals-engine/judges/instructions.js");
const conv = await import("../src/evals-engine/judges/conversation-judges.js");
const varx = await import("../src/evals-engine/judges/variable-extraction.js");
const { MockLLM } = await import("../src/llm/index.js");
const { runHallucinationJudge } = await import("../src/evals-engine/judges/node-judges.js");
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

const catalogueOverrides = () =>
  new Map(
    DEFAULT_JUDGE_ROWS.filter((r) => r.kind === "llm" && r.prompt !== null).map((r) => [
      r.name,
      {
        body: r.prompt!.body,
        output: r.prompt!.output,
        ...(r.prompt!.sub_prompts ? { sub_prompts: r.prompt!.sub_prompts } : {}),
      },
    ]),
  );

/** name → the shipped [body, output] constants, straight from the modules. */
const SHIPPED: Record<string, [string, string]> = {
  instructions_adherence: [instructions.INSTRUCTION_ADHERENCE, instructions.OUT_INSTRUCTION],
  intent_identification: [instructions.INTENT_IDENTIFICATION, instructions.OUT_INTENT],
  variable_extraction: [instructions.VARIABLE_EXTRACTION, instructions.OUT_VARIABLE],
  hallucination: [instructions.HALLUCINATION, instructions.OUT_HALLUCINATION],
  node_loop: [instructions.LOOP_DETECTION, instructions.OUT_LOOP],
  voicemail_detection: [conv.VOICEMAIL, conv.OUT_DETECTION],
  bot_detection: [conv.BOT, conv.OUT_DETECTION],
  call_screening: [conv.CALL_SCREENING, conv.OUT_DETECTION],
  low_engagement: [conv.LOW_ENGAGEMENT, conv.OUT_DETECTION],
  wrong_number: [conv.WRONG_NUMBER, conv.OUT_DETECTION],
  do_not_disturb: [conv.DO_NOT_DISTURB, conv.OUT_DETECTION],
  user_sentiment: [conv.USER_SENTIMENT, conv.OUT_SENTIMENT],
  stt: [conv.STT, conv.OUT_STT],
  transfer_consent: [conv.TRANSFER_CONSENT, conv.OUT_TRANSFER_CONSENT],
};

describe("judge registry parity", () => {
  test("catalogue covers exactly the shipped LLM judges plus the two code judges", () => {
    const llmNames = DEFAULT_JUDGE_ROWS.filter((r) => r.kind === "llm").map((r) => r.name);
    expect(llmNames.toSorted()).toEqual(Object.keys(SHIPPED).toSorted());
    const codeNames = DEFAULT_JUDGE_ROWS.filter((r) => r.kind === "code").map((r) => r.name);
    expect(codeNames.toSorted()).toEqual(["human_transfer", "user_never_spoke"]);
  });

  test("every catalogue prompt is byte-identical to the shipped constants", () => {
    for (const [name, [body, output]] of Object.entries(SHIPPED)) {
      const row = DEFAULT_JUDGE_ROWS.find((r) => r.name === name)!;
      expect(row.prompt!.body).toBe(body);
      expect(row.prompt!.output).toBe(output);
    }
    const vx = DEFAULT_JUDGE_ROWS.find((r) => r.name === "variable_extraction")!;
    expect(vx.prompt!.sub_prompts!.review_config_default).toBe(varx.CONFIG_DEFAULT_REVIEW_SYSTEM);
    expect(vx.prompt!.sub_prompts!.review_focused_defect).toBe(varx.FOCUSED_DEFECT_REVIEW_SYSTEM);
  });

  test("node-judge system builders are byte-identical with overrides applied", () => {
    const build = () => [
      instructions.systemForHallucination(),
      instructions.systemForLoop(),
      instructions.systemForInstructionAdherence("Ask for the order id.", "(none)"),
      instructions.systemForIntent("- provide_order: caller gives the id", "provide_order"),
      instructions.systemForVariableExtraction("- order_id — rule: capture", "- order_id: \"42\""),
    ];
    prompts.clearJudgePromptOverrides();
    const shipped = build();
    try {
      prompts.setJudgePromptOverrides(catalogueOverrides());
      expect(build()).toEqual(shipped);
    } finally {
      prompts.clearJudgePromptOverrides();
    }
  });

  test("a judge call sends the byte-identical system prompt with overrides applied", async () => {
    const node: NodeEvalInput = {
      node_uuid: "n1", node_name: "collect_order", node_prompt: "Ask for the order id.",
      available_intents: [], chosen_intent: "", required_variables: [], extracted_variables: {},
      turns: [{ node_uuid: "n1", user: "hi", agent: "hello", intent: "" }], turn_count: 1,
    };
    const ctx: ConversationInput = {
      flow_name: "orders", global_prompt: "g", nodes: [node], goals: [],
      full_transcript: "User: hi\nAgent: hello",
    };
    const reply = JSON.stringify({ hallucinated: false, score: 1, reason: "r", technical_reason: "t" });

    prompts.clearJudgePromptOverrides();
    const a = new MockLLM([reply]);
    await runHallucinationJudge(node, ctx, a);
    try {
      prompts.setJudgePromptOverrides(catalogueOverrides());
      const b = new MockLLM([reply]);
      await runHallucinationJudge(node, ctx, b);
      expect(b.calls[0]!.system).toBe(a.calls[0]!.system);
      expect(b.calls[0]!.input).toEqual(a.calls[0]!.input);
    } finally {
      prompts.clearJudgePromptOverrides();
    }
  });

  test("an override that DOES differ is honoured (the store is live, not decorative)", () => {
    prompts.clearJudgePromptOverrides();
    try {
      prompts.setJudgePromptOverrides(
        new Map([["hallucination", { body: "CUSTOM BODY", output: "CUSTOM OUT" }]]),
      );
      expect(instructions.systemForHallucination()).toBe("CUSTOM BODY\n\nCUSTOM OUT");
    } finally {
      prompts.clearJudgePromptOverrides();
    }
  });
});
