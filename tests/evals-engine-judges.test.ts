import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

// Mock config so importing the llm module (via the judges) doesn't parse real env.
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { runHallucinationJudge, runLoopJudge, runInstructionAdherenceJudge } = await import(
  "../src/evals-engine/judges/node-judges.js"
);
const { runVariableExtractionJudge } = await import("../src/evals-engine/judges/variable-extraction.js");
const { runIntentJudge } = await import("../src/evals-engine/judges/intent-judge.js");
const { runGoalJudge } = await import("../src/evals-engine/judges/goal-judge.js");
const { deriveInstructionAdherence } = await import("../src/evals-engine/aggregate.js");
type NodeEvalInput = import("../src/evals-engine/types.js").NodeEvalInput;
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

const node = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1",
  node_name: "collect_order",
  node_prompt: "Ask for the order id and confirm it.",
  available_intents: [{ id: "e1", intent_name: "provide_order" }],
  chosen_intent: "provide_order",
  required_variables: ["order_id"],
  extracted_variables: { order_id: "42" },
  turns: [
    { node_uuid: "n1", user: "my order is 42", agent: "Got it, order 42.", intent: "provide_order" },
  ],
  turn_count: 1,
  ...over,
});

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "orders",
  global_prompt: "You are a helpful orders agent.",
  nodes: [node()],
  goals: [],
  full_transcript: "User: my order is 42\nAgent: Got it, order 42.",
  ...over,
});

describe("LLM node judges (MockLLM)", () => {
  test("hallucination: parses raw output; sends criteria+output system and node transcript", async () => {
    const llm = new MockLLM([JSON.stringify({ hallucinated: false, score: 1, reason: "grounded", technical_reason: "t" })]);
    const { data } = await runHallucinationJudge(node(), ctx(), llm);
    expect(data.hallucinated).toBe(false);
    expect(data.score).toBe(1);
    expect(llm.calls[0]!.system).toContain("fabricated information");
    expect(llm.calls[0]!.system).toContain('"hallucinated": boolean');
    // strict json_schema (cx-sqs parity) is passed to the provider
    expect(llm.calls[0]!.jsonSchema?.strict).toBe(true);
    expect(llm.calls[0]!.jsonSchema?.name).toBe("eval_hallucination");
    expect((llm.calls[0]!.jsonSchema?.schema as any).required).toContain("hallucinated");
    expect((llm.calls[0]!.jsonSchema?.schema as any).additionalProperties).toBe(false);
    const sent = JSON.parse(llm.calls[0]!.user);
    expect(sent.node_transcript).toContain("order is 42");
  });

  test("hallucination: unconfigured node (no node_prompt, no global_prompt) → neutral pass, no LLM call", async () => {
    // A node ref the config doesn't know (e.g. a screening segment the sender
    // never exported) reaches the judge with an empty prompt. With no config
    // grounding surface at all, the judge reads the agent's own configured
    // identity ("Maya from BrightSmile Dental") as fabricated — 10/13 dev
    // screening calls false-fired this way on 2026-08-04.
    const llm = new MockLLM([JSON.stringify({ hallucinated: true, score: 0, reason: "should not be called", technical_reason: "t" })]);
    const { data, usage } = await runHallucinationJudge(node({ node_prompt: "" }), ctx({ global_prompt: "" }), llm);
    expect(llm.calls.length).toBe(0);
    expect(data.hallucinated).toBe(false);
    expect(data.score).toBe(1);
    expect(data.technical_reason).toContain("skipped");
    expect(usage.totalTokens).toBe(0);
  });

  test("hallucination: empty node_prompt still judges when a global_prompt exists", async () => {
    // A global prompt is a real grounding surface (evidence source 3) — the
    // neutral skip is only for segments with NO configured instructions at all.
    const llm = new MockLLM([JSON.stringify({ hallucinated: false, score: 1, reason: "grounded", technical_reason: "t" })]);
    const { data } = await runHallucinationJudge(node({ node_prompt: "" }), ctx(), llm);
    expect(llm.calls.length).toBe(1);
    expect(data.hallucinated).toBe(false);
  });

  test("every judge call carries the configured reasoning effort", async () => {
    // The per-judge output caps (1500-5000) are copied from cx-sqs, which pins
    // effort "none". AO never sent the parameter, so judges inherited the model's
    // default effort and spent the visible-output budget on invisible reasoning
    // tokens → terminal reason="max_output_tokens" (prod, 2026-07-14).
    const llm = new MockLLM([JSON.stringify({ hallucinated: false, score: 1, reason: "grounded", technical_reason: "t" })]);
    await runHallucinationJudge(node(), ctx(), llm);
    expect(llm.calls[0]!.reasoningEffort).toBe("none");
    expect(llm.calls[0]!.maxTokens).toBe(1500); // parity cap unchanged — effort is what makes it sufficient
  });

  test("an unset JUDGE_REASONING_EFFORT omits the parameter (pre-#114 wire shape)", async () => {
    // The operator writes "inherit" when a deployment REJECTS an explicit effort value
    // ("none" is not universally valid across gpt-5.x) and a rejected enum 400s every judge
    // call. The schema collapses that sentinel to undefined at parse time, so what this path
    // actually sees is undefined — that is what is asserted here. (Setting the literal
    // "inherit" on the parsed config would be testing a state the schema cannot produce.)
    // The judge runner reads config at call time, so mutate-and-restore.
    const { config } = await import("../src/config.js");
    const prior = (config as Record<string, unknown>).JUDGE_REASONING_EFFORT;
    (config as Record<string, unknown>).JUDGE_REASONING_EFFORT = undefined;
    try {
      const llm = new MockLLM([JSON.stringify({ hallucinated: false, score: 1, reason: "grounded", technical_reason: "t" })]);
      await runHallucinationJudge(node(), ctx(), llm);
      expect(llm.calls[0]!.reasoningEffort).toBeUndefined();
    } finally {
      (config as Record<string, unknown>).JUDGE_REASONING_EFFORT = prior;
    }
  });

  test("loop: parses raw output", async () => {
    const llm = new MockLLM([JSON.stringify({ loop_detected: false, score: 1, reason: "no loop" })]);
    const { data } = await runLoopJudge(node(), ctx(), llm);
    expect(data.loop_detected).toBe(false);
  });

  test("variable extraction: expected + actual variables land in the system prompt", async () => {
    const llm = new MockLLM([JSON.stringify({ extraction_successful: true, score: 1, reason: "ok" })]);
    const { data } = await runVariableExtractionJudge(node(), ctx(), llm);
    expect(data.extraction_successful).toBe(true);
    expect(llm.calls[0]!.system).toContain("order_id");
    expect(llm.calls[0]!.system).toContain("42");
  });

  test("variable extraction: final boolean cannot fail without a structured defect", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "generic concern",
        technical_reason: "no variable defect identified",
        missing_variables: [],
        incorrect_variables: [],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(node(), ctx(), llm);

    expect(data.extraction_successful).toBe(true);
    expect(data.score).toBe(1);
  });

  test("variable extraction: an unconfigured stored name remains a failure", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "extra variable",
        technical_reason: "unexpected_field is not configured",
        missing_variables: [],
        incorrect_variables: [],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({ extracted_variables: { order_id: "42", unexpected_field: "x" } }),
      ctx(),
      llm,
    );

    expect(data.extraction_successful).toBe(false);
  });

  test("variable extraction: variable rules and decision boundary are repeated after the call payload", async () => {
    const llm = new MockLLM([JSON.stringify({ extraction_successful: true, score: 1, reason: "ok" })]);
    await runVariableExtractionJudge(
      node({ variable_rules: { order_id: "Capture only when the caller explicitly states it." } }),
      ctx(),
      llm,
    );

    const sent = JSON.parse(llm.calls[0]!.user);
    expect(sent.variable_rules).toEqual({ order_id: "Capture only when the caller explicitly states it." });
    expect(sent.variable_judge_contract).toContain("recording rule is authoritative");
    expect(sent.variable_judge_contract).toContain("unreached or inapplicable");
    expect(sent.variable_judge_contract).toContain("backend, platform, tool, and lookup values");
    expect(Object.keys(sent).at(-1)).toBe("variable_judge_contract");
  });

  test("variable extraction: configured defaults are labelled for the judge", async () => {
    const llm = new MockLLM([JSON.stringify({ extraction_successful: true, score: 1, reason: "ok" })]);
    await runVariableExtractionJudge(
      node({
        required_variables: ["remember_form"],
        variable_rules: { remember_form: "Extract yes if the caller remembers or does not dispute filling the form." },
        extracted_variables: { remember_form: "yes" },
      }),
      ctx(),
      llm,
    );

    expect(llm.calls[0]!.system).toContain("CONFIG-DIRECTED DEFAULT");
    expect(llm.calls[0]!.system).toContain("valid without an affirmative caller utterance");
  });

  test("variable extraction: high-confidence workflow and action-result rules are labelled", async () => {
    const llm = new MockLLM([JSON.stringify({ extraction_successful: true, score: 1, reason: "ok" })]);
    await runVariableExtractionJudge(
      node({
        required_variables: ["property_key", "routing_result"],
        variable_rules: {
          property_key: "Internal identifier returned by the listing action.",
          routing_result: "Mapped workflow disposition selected by the agent.",
        },
        extracted_variables: {},
      }),
      ctx(),
      llm,
    );

    expect(llm.calls[0]!.system).toContain("property_key — judge classification: PLATFORM/BACKEND FIELD");
    expect(llm.calls[0]!.system).toContain("routing_result — judge classification: WORKFLOW FIELD");
  });

  test("variable extraction: workflow and backend fields stay out of scope even when their rules say default", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.25,
        reason: "workflow issues",
        technical_reason: "main review",
        missing_variables: ["property_key"],
        incorrect_variables: ["outcome_status"],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["property_key", "outcome_status"],
        variable_rules: {
          property_key: "Internal identifier returned by the listing action; empty by default.",
          outcome_status: "Agent-authored workflow status; use completed by default.",
        },
        extracted_variables: { outcome_status: "follow_up" },
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(1);
    expect(data.extraction_successful).toBe(true);
    expect(data.missing_variables).toEqual([]);
    expect(data.incorrect_variables).toEqual([]);
  });

  test("variable extraction: a caller-capture status name is not deterministically excluded", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "visa status missing",
        technical_reason: "caller stated the status",
        missing_variables: ["visa_status"],
        incorrect_variables: [],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "visa_status", issue_type: "missing", defect_confirmed: true, evidence: "Caller said the visa is approved." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["visa_status"],
        variable_rules: { visa_status: "Capture the caller's stated visa status." },
        extracted_variables: {},
        turns: [{ node_uuid: "n1", user: "My visa is approved", agent: "Thanks", intent: "" }],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(false);
    expect(data.missing_variables).toEqual(["visa_status"]);
  });

  test("variable extraction: structured cutoff is called out after the long node prompt", async () => {
    const llm = new MockLLM([JSON.stringify({ extraction_successful: true, score: 1, reason: "ok" })]);
    await runVariableExtractionJudge(
      node({
        node_prompt: "Submit lead data before any transfer.",
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "", agent: "Let me transfer you now [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    const sent = JSON.parse(llm.calls[0]!.user);
    expect(sent.variable_judge_contract).toContain("FINAL RECORDING BATCH CUTOFF CONFIRMED");
    expect(sent.variable_judge_contract).toContain("unless its own rule required earlier recording");
    expect(sent.variable_recording_schedule).toContain("Submit lead data before any transfer");
  });

  test("variable extraction: a later tool turn prevents the structured cutoff signal", async () => {
    const llm = new MockLLM([JSON.stringify({ extraction_successful: true, score: 1, reason: "ok" })]);
    await runVariableExtractionJudge(
      node({
        node_prompt: "Submit lead data before any transfer.",
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "", agent: "Let me transfer you now [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
          { node_uuid: "n1", user: "", agent: "Tool_Call: submit_lead_data", intent: "", evidence: true },
        ],
      }),
      ctx(),
      llm,
    );

    const sent = JSON.parse(llm.calls[0]!.user);
    expect(sent.variable_judge_contract).not.toContain("FINAL RECORDING BATCH CUTOFF CONFIRMED");
  });

  test("variable extraction: an interrupted non-terminal question cannot trigger final-batch clearing", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "order id missing",
        technical_reason: "caller stated the value",
        missing_variables: ["order_id"],
        incorrect_variables: [],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "order_id", issue_type: "missing", defect_confirmed: true, evidence: "Caller said 42." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        node_prompt: "Submit lead data before any transfer.",
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "My order is 42", agent: "", intent: "" },
          { node_uuid: "n1", user: "", agent: "Could you confirm that reference [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Yes", agent: "", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    const sent = JSON.parse(llm.calls[0]!.user);
    expect(sent.variable_judge_contract).not.toContain("FINAL RECORDING BATCH CUTOFF CONFIRMED");
    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(false);
    expect(data.missing_variables).toEqual(["order_id"]);
  });

  test("variable extraction: final-batch cutoff clears only a candidate covered by the batch schedule", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.25,
        reason: "lead data missing",
        technical_reason: "values were said earlier",
        missing_variables: ["order_id"],
        incorrect_variables: [],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        node_prompt: "Submit lead data before any transfer.",
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "my order is 42", agent: "", intent: "" },
          { node_uuid: "n1", user: "", agent: "Let me transfer you now [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(1);
    expect(data.extraction_successful).toBe(true);
    expect(data.score).toBe(1);
    expect(data.missing_variables).toEqual([]);
    expect(data.incorrect_variables).toEqual([]);
    expect(data.technical_reason).toContain("structured final-batch schedule");
  });

  test("variable extraction: final-batch cutoff recognizes submission-action wording", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "lead value missing",
        technical_reason: "main review",
        missing_variables: ["order_id"],
        incorrect_variables: [],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        node_prompt: "Before any ending outcome or transfer, use the lead data submission action once with all known details.",
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "Order 42", agent: "", intent: "" },
          { node_uuid: "n1", user: "", agent: "Let me transfer you now [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(1);
    expect(data.extraction_successful).toBe(true);
    expect(data.missing_variables).toEqual([]);
  });

  test("variable extraction: final-batch cutoff uses generic batch details rather than lead-only wording", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "booking reference missing",
        technical_reason: "main review",
        missing_variables: ["booking_reference"],
        incorrect_variables: [],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        node_prompt: "Before transfer, record all booking details in one final submission.",
        required_variables: ["booking_reference"],
        variable_rules: { booking_reference: "Capture the booking reference provided by the caller." },
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "The reference is AB42", agent: "", intent: "" },
          { node_uuid: "n1", user: "", agent: "I will transfer you now [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(1);
    expect(data.extraction_successful).toBe(true);
    expect(data.missing_variables).toEqual([]);
  });

  test("variable extraction: unquantified flow-specific details do not clear unrelated omissions", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "booking reference missing",
        technical_reason: "caller stated the value",
        missing_variables: ["booking_reference"],
        incorrect_variables: [],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "booking_reference", issue_type: "missing", defect_confirmed: true, evidence: "Caller said AB42." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        node_prompt: "Before transfer, record booking details.",
        required_variables: ["booking_reference"],
        variable_rules: { booking_reference: "Capture the booking reference provided by the caller." },
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "The reference is AB42", agent: "", intent: "" },
          { node_uuid: "n1", user: "", agent: "I will transfer you now [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(false);
    expect(data.missing_variables).toEqual(["booking_reference"]);
  });

  test("variable extraction: cutoff review preserves a confirmed non-batch omission", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "name missing",
        technical_reason: "name should have been recorded immediately",
        missing_variables: ["customer_name"],
        incorrect_variables: [],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "customer_name", issue_type: "missing", defect_confirmed: true, evidence: "Caller stated the name before the final batch." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        node_prompt: "Record the caller name immediately. Submit remaining lead data before any transfer.",
        required_variables: ["customer_name"],
        variable_rules: { customer_name: "Record the caller-stated name immediately." },
        extracted_variables: {},
        turns: [
          { node_uuid: "n1", user: "My name is Vijay", agent: "", intent: "" },
          { node_uuid: "n1", user: "", agent: "Let me transfer you now [interrupted]", intent: "" },
          { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(false);
    expect(data.missing_variables).toEqual(["customer_name"]);
  });

  test("variable extraction: configured default gets a focused exception review", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "identity was not confirmed",
        technical_reason: "the caller did not answer the identity question",
        missing_variables: [],
        incorrect_variables: ["remember_form"],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "remember_form", issue_type: "incorrect", defect_confirmed: false, evidence: "No exception was stated." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["remember_form"],
        variable_rules: {
          remember_form: "Extract yes if the caller remembers or does not dispute. Extract no for a wrong person.",
        },
        extracted_variables: { remember_form: "yes" },
        turns: [{ node_uuid: "n1", user: "Please call this afternoon", agent: "Sure", intent: "" }],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(true);
    expect(data.incorrect_variables).toEqual([]);
    expect(data.technical_reason).toContain("focused config-default review");
  });

  test("variable extraction: focused review preserves an explicitly established default exception", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "wrong person",
        technical_reason: "caller said this is the wrong number",
        missing_variables: [],
        incorrect_variables: ["remember_form"],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "remember_form", issue_type: "incorrect", defect_confirmed: true, evidence: "Caller said wrong number." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["remember_form"],
        variable_rules: {
          remember_form: "Extract yes if the caller remembers or does not dispute. Extract no for a wrong person.",
        },
        extracted_variables: { remember_form: "yes" },
        turns: [{ node_uuid: "n1", user: "This is the wrong number", agent: "Sorry", intent: "" }],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(false);
    expect(data.incorrect_variables).toEqual(["remember_form"]);
  });

  test("variable extraction: independent guarded reviews reconcile their rejections once", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.25,
        reason: "two proposed defects",
        technical_reason: "main review",
        missing_variables: ["graduation_year"],
        incorrect_variables: ["remember_form"],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "remember_form", issue_type: "incorrect", defect_confirmed: false, evidence: "No default exception." },
        ],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "graduation_year", issue_type: "missing", defect_confirmed: false, evidence: "Only a relative year." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["graduation_year", "remember_form"],
        variable_rules: {
          graduation_year: "Capture a four-digit graduation year stated by the caller.",
          remember_form: "Extract yes when the caller does not dispute the submitted form; use no for a wrong person.",
        },
        extracted_variables: { remember_form: "yes" },
        turns: [{ node_uuid: "n1", user: "I graduated last year", agent: "Thanks", intent: "" }],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(3);
    expect(data.extraction_successful).toBe(true);
    expect(data.missing_variables).toEqual([]);
    expect(data.incorrect_variables).toEqual([]);
    expect(data.technical_reason).toContain("focused config-default review");
    expect(data.technical_reason).toContain("focused defect review");
  });

  test("variable extraction: focused defect review removes derived/default omissions and rule-authorized values", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.25,
        reason: "several defects",
        technical_reason: "main review",
        missing_variables: ["graduation_year", "preferred_university"],
        incorrect_variables: ["callback_time"],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "graduation_year", issue_type: "missing", defect_confirmed: false, evidence: "Only derivable." },
          { variable_name: "preferred_university", issue_type: "missing", defect_confirmed: false, evidence: "Default only." },
          { variable_name: "callback_time", issue_type: "incorrect", defect_confirmed: false, evidence: "Rule allows counselor time." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["graduation_year", "preferred_university", "callback_time"],
        variable_rules: {
          graduation_year: "Capture the graduation year if stated; otherwise not_provided.",
          preferred_university: "Capture the chosen university; if not asked, capture not_asked.",
          callback_time: "Capture a preferred callback or counselor-review time.",
        },
        extracted_variables: { callback_time: "16:00" },
        turns: [
          { node_uuid: "n1", user: "I graduated last year", agent: "Which university?", intent: "" },
          { node_uuid: "n1", user: "Please have the counselor call at 4 PM", agent: "Noted", intent: "" },
        ],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(true);
    expect(data.missing_variables).toEqual([]);
    expect(data.incorrect_variables).toEqual([]);
    expect(data.technical_reason).toContain("focused defect review");
  });

  test("variable extraction: focused defect review preserves a real caller-stated omission", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "order id missing",
        technical_reason: "main review",
        missing_variables: ["order_id"],
        incorrect_variables: [],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "order_id", issue_type: "missing", defect_confirmed: true, evidence: "Caller said 42." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({ extracted_variables: {} }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(false);
    expect(data.missing_variables).toEqual(["order_id"]);
  });

  test("variable extraction: explicit-speech rule violations bypass leniency review", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "precise bucket was invented",
        technical_reason: "caller said only a lot",
        missing_variables: [],
        incorrect_variables: ["team_size_bucket"],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["team_size_bucket"],
        variable_rules: { team_size_bucket: "Capture the exact bucket only when the caller explicitly states the team size." },
        extracted_variables: { team_size_bucket: "more than six" },
        turns: [{ node_uuid: "n1", user: "We have a lot of callers", agent: "Okay", intent: "" }],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(1);
    expect(data.extraction_successful).toBe(false);
    expect(data.incorrect_variables).toEqual(["team_size_bucket"]);
  });

  test("variable extraction: explicit-speech missing proposals still receive precision review", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        extraction_successful: false,
        score: 0.5,
        reason: "bucket missing",
        technical_reason: "caller said a lot",
        missing_variables: ["team_size_bucket"],
        incorrect_variables: [],
      }),
      JSON.stringify({
        reviews: [
          { variable_name: "team_size_bucket", issue_type: "missing", defect_confirmed: false, evidence: "No precise bucket was stated." },
        ],
      }),
    ]);
    const { data } = await runVariableExtractionJudge(
      node({
        required_variables: ["team_size_bucket"],
        variable_rules: { team_size_bucket: "Capture the exact bucket only when the caller explicitly states the team size." },
        extracted_variables: {},
        turns: [{ node_uuid: "n1", user: "We have a lot of callers", agent: "Okay", intent: "" }],
      }),
      ctx(),
      llm,
    );

    expect(llm.calls).toHaveLength(2);
    expect(data.extraction_successful).toBe(true);
    expect(data.missing_variables).toEqual([]);
  });

  test("instruction adherence: returns the 4 sub-metrics", async () => {
    const raw = {
      objective_progress: { achieved: true, score: 1, reason_code: "goal_achieved", reason: "", technical_reason: "" },
      procedure_compliance: { score: 1, reason_code: "", missed_steps: [], reason: "", technical_reason: "" },
      interaction_quality: { score: 0.9, reason_code: "", issues: [], reason: "", technical_reason: "" },
      policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
    };
    const llm = new MockLLM([JSON.stringify(raw)]);
    const { data } = await runInstructionAdherenceJudge(node(), ctx(), llm);
    expect(data.objective_progress.achieved).toBe(true);
    expect(data.procedure_compliance.missed_steps).toEqual([]);
  });

  test('instruction adherence: a "Critical" missed step (any casing) fails procedure compliance', async () => {
    const raw = {
      objective_progress: { achieved: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
      procedure_compliance: {
        score: 0.5,
        reason_code: "",
        missed_steps: [{ step: "verify identity", severity: "Critical", reason_code: "skipped", details: "" }],
        reason: "",
        technical_reason: "",
      },
      interaction_quality: { score: 0.9, reason_code: "", issues: [], reason: "", technical_reason: "" },
      policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
    };
    const llm = new MockLLM([JSON.stringify(raw)]);
    const { data } = await runInstructionAdherenceJudge(node(), ctx(), llm);
    // severity is normalized to lowercase by the schema
    expect(data.procedure_compliance.missed_steps[0]!.severity).toBe("critical");
    const derived = deriveInstructionAdherence(data);
    expect(derived.procedure_compliance.passed).toBe(false);
    expect(derived.adherence_passed).toBe(false);
  });

  test("instruction adherence: an unknown severity value coerces to minor (does not fail procedure)", async () => {
    const raw = {
      objective_progress: { achieved: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
      procedure_compliance: {
        score: 0.9,
        reason_code: "",
        missed_steps: [{ step: "s", severity: "catastrophic", reason_code: "", details: "" }],
        reason: "",
        technical_reason: "",
      },
      interaction_quality: { score: 0.9, reason_code: "", issues: [], reason: "", technical_reason: "" },
      policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
    };
    const llm = new MockLLM([JSON.stringify(raw)]);
    const { data } = await runInstructionAdherenceJudge(node(), ctx(), llm);
    expect(data.procedure_compliance.missed_steps[0]!.severity).toBe("minor");
    expect(deriveInstructionAdherence(data).procedure_compliance.passed).toBe(true);
  });
});

describe("intent judge (LLM, cx-sqs MetricIntent)", () => {
  test("both flags false → score 1; available intents land in the system prompt", async () => {
    const llm = new MockLLM([JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "correct" })]);
    const { data } = await runIntentJudge(node(), ctx(), llm);
    expect(data.score).toBe(1);
    expect(data.intent_wrongly_identified).toBe(false);
    expect(llm.calls[0]!.system).toContain("provide_order");
    expect(llm.calls[0]!.system).toContain('"intent_not_found": boolean');
  });
  test("wrongly identified → score 0", async () => {
    const llm = new MockLLM([JSON.stringify({ intent_not_found: false, intent_wrongly_identified: true, reason: "mismatch" })]);
    const { data } = await runIntentJudge(node(), ctx(), llm);
    expect(data.score).toBe(0);
    expect(data.intent_wrongly_identified).toBe(true);
  });
  test("intent not found → score 0", async () => {
    const llm = new MockLLM([JSON.stringify({ intent_not_found: true, intent_wrongly_identified: false, reason: "not in list" })]);
    const { data } = await runIntentJudge(node(), ctx(), llm);
    expect(data.score).toBe(0);
    expect(data.intent_not_found).toBe(true);
  });
});

describe("goal judge (MockLLM)", () => {
  test("re-attaches flow_goal_id and defaults a goal the model skipped", async () => {
    const goals = [
      { goal_name: "confirm_order", goal_instructions: "confirm the order id", flow_goal_id: 7 },
      { goal_name: "offer_help", goal_instructions: "offer further help", flow_goal_id: 8 },
    ];
    // model returns only the first goal
    const llm = new MockLLM([JSON.stringify({ goals: [{ goal_name: "confirm_order", achieved: true, reason: "did", technical_reason: "" }] })]);
    const { data } = await runGoalJudge(goals, ctx(), llm);
    expect(data.goals).toHaveLength(2);
    expect(data.goals[0]).toMatchObject({ goal_name: "confirm_order", flow_goal_id: 7, achieved: true });
    expect(data.goals[1]).toMatchObject({ goal_name: "offer_help", flow_goal_id: 8, achieved: false, reason: "Goal not evaluated by LLM" });
  });

  test("a shapeless reply ({} / empty goals) triggers a retry instead of silent all-unmet", async () => {
    const goals = [{ goal_name: "confirm_order", goal_instructions: "confirm", flow_goal_id: 7 }];
    // First reply is valid JSON but the wrong shape ({}); second is empty goals (also
    // rejected by min(1)); third is correct. completeJSON must re-prompt through both.
    const llm = new MockLLM([
      JSON.stringify({}),
      JSON.stringify({ goals: [] }),
      JSON.stringify({ goals: [{ goal_name: "confirm_order", achieved: true, reason: "did", technical_reason: "" }] }),
    ]);
    const { data } = await runGoalJudge(goals, ctx(), llm);
    expect(data.goals[0]).toMatchObject({ goal_name: "confirm_order", achieved: true });
    expect(llm.calls).toHaveLength(3); // proves the wrong shapes were retried, not accepted
  });
});

describe("strict json_schema passed by every LLM judge (cx-sqs parity)", () => {
  test("loop, variable, instruction, intent, goal each send a strict schema with the expected name", async () => {
    const mk = (json: string) => new MockLLM([json]);
    const loopLlm = mk(JSON.stringify({ loop_detected: false, score: 1 }));
    const varLlm = mk(JSON.stringify({ extraction_successful: true, score: 1 }));
    const adhLlm = mk(
      JSON.stringify({
        objective_progress: { achieved: true, score: 1 },
        procedure_compliance: { score: 1, missed_steps: [] },
        interaction_quality: { score: 1, issues: [] },
        policy_boundary_compliance: { passed: true, score: 1 },
      }),
    );
    const intentLlm = mk(JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false }));
    const goalLlm = mk(JSON.stringify({ goals: [{ goal_name: "g", achieved: true }] }));

    await runLoopJudge(node(), ctx(), loopLlm);
    await runVariableExtractionJudge(node(), ctx(), varLlm);
    await runInstructionAdherenceJudge(node(), ctx(), adhLlm);
    await runIntentJudge(node(), ctx(), intentLlm);
    await runGoalJudge([{ goal_name: "g", goal_instructions: "do g", flow_goal_id: 1 }], ctx(), goalLlm);

    const check = (llm: { calls: Array<{ jsonSchema?: { name: string; strict?: boolean; schema: unknown } }> }, name: string) => {
      expect(llm.calls[0]!.jsonSchema?.strict).toBe(true);
      expect(llm.calls[0]!.jsonSchema?.name).toBe(name);
      expect((llm.calls[0]!.jsonSchema?.schema as any).additionalProperties).toBe(false);
    };
    check(loopLlm, "eval_loop");
    check(varLlm, "eval_variable");
    check(adhLlm, "eval_instruction");
    check(intentLlm, "eval_intent");
    check(goalLlm, "eval_goal");
  });
});

describe("adherence payload — SER-6035 #2: drop intent descriptions for adherence ONLY", () => {
  test("adherenceNodePayload omits available_intents but keeps chosen_intent + node_prompt", async () => {
    const { adherenceNodePayload } = await import("../src/evals-engine/judges/node-judge-payload.js");
    const payload = adherenceNodePayload(node(), ctx());
    expect("available_intents" in payload).toBe(false);
    // which intent fired is still useful context and is kept
    expect(payload.chosen_intent).toBe("provide_order");
    expect(payload.node_prompt).toBeDefined();
  });

  test("the SHARED nodePayload STILL carries available_intents — hallucination/loop/variable are untouched", async () => {
    const { nodePayload } = await import("../src/evals-engine/judges/node-judge-payload.js");
    const payload = nodePayload(node(), ctx());
    // No collateral: the other node judges keep the handoff-intent context they
    // legitimately use (e.g. hallucination grounding an offered transfer path).
    expect("available_intents" in payload).toBe(true);
    expect(payload.available_intents).toEqual([{ id: "e1", intent_name: "provide_order" }]);
  });

  test("wiring: adherence judge SENDS no available_intents; hallucination judge STILL sends it", async () => {
    const adh = JSON.stringify({
      objective_progress: { achieved: true, score: 1, reason_code: "goal_achieved", reason: "r", technical_reason: "t" },
      procedure_compliance: { score: 1, reason_code: "procedure_followed", missed_steps: [], reason: "r", technical_reason: "t" },
      interaction_quality: { score: 1, reason_code: "no_quality_issues", issues: [], reason: "r", technical_reason: "t" },
      policy_boundary_compliance: { passed: true, score: 1, reason_code: "boundary_respected", reason: "r", technical_reason: "t" },
    });
    const adhLlm = new MockLLM([adh]);
    await runInstructionAdherenceJudge(node(), ctx(), adhLlm);
    expect("available_intents" in JSON.parse(adhLlm.calls[0]!.user)).toBe(false);

    const halLlm = new MockLLM([JSON.stringify({ hallucinated: false, score: 1, reason: "g", technical_reason: "t" })]);
    await runHallucinationJudge(node(), ctx(), halLlm);
    expect("available_intents" in JSON.parse(halLlm.calls[0]!.user)).toBe(true);
  });
});
