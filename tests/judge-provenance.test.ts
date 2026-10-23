import { describe, test, expect, mock } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

const testConfig: Record<string, unknown> = { ...TEST_JUDGE_CONFIG_MODULE.config };
mock.module("../src/config.js", () => ({ ...TEST_JUDGE_CONFIG_MODULE, config: testConfig }));

const { MockLLM, systemPromptAsSent } = await import("../src/llm/index.js");
const { MockJev } = await import("../src/jev/mock.js");
const { runLlmJudge } = await import("../src/evals-engine/judges/run-llm-judge.js");
const { runCustomMetricJudges, CUSTOM_METRIC_OUT } = await import("../src/evals-engine/judges/custom-metric.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
const { buildExternalEvalRows } = await import("../src/evals-engine/fan-out-rows.js");
const { defaultJudgeResponder } = await import("./fixtures/default-judge-responder.js");
const { setJudgePromptOverrides, clearJudgePromptOverrides } = await import("../src/evals-engine/judges/judge-prompts.js");
const { INSTRUCTION_ADHERENCE, OUT_INSTRUCTION } = await import("../src/evals-engine/judges/instructions.js");
type AgentConfig = import("../src/evals-engine/integration/session-evals.js").AgentConfig;
type StoredEvent = import("../src/evals-engine/integration/session-evals.js").StoredEvent;
type ProviderCompleteArgs = import("../src/llm/types.js").ProviderCompleteArgs;
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;

const PRIMARY = TEST_JUDGE_CONFIG_MODULE.config.JUDGE_MODEL;
const FALLBACK = "fallback-judge-model";

const agentConfig = (node: Record<string, unknown> = {}): AgentConfig => ({
  flow_name: "orders",
  global_prompt: "You are an orders agent.",
  nodes: [{
    ref: "node-A",
    name: "collect_order",
    instructions: "Ask for the order id and confirm it.",
    intents: [{ name: "provide_order", description: "the caller states their order id" }],
    variables: [{ name: "order_id", rule: "Record the order id the caller states." }],
    ...node,
  }],
});

const events: StoredEvent[] = [
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "What is your order id?" } },
  { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "user", content: "It is 42." } },
];

const answer = (args: ProviderCompleteArgs) =>
  defaultJudgeResponder(args.system) ?? JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });

const rateLimited = () => Object.assign(new Error("429 Too Many Requests"), { status: 429, retryAfterMs: 0 });

async function withConfig<T>(over: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, testConfig[k]]));
  Object.assign(testConfig, over);
  try {
    return await body();
  } finally {
    Object.assign(testConfig, saved);
  }
}

async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await body();
  } finally {
    Object.assign(console, { warn, error });
  }
}

const CODE_DERIVED = new Set(["user_never_spoke", "human_transfer"]);

describe("LLM verdict provenance", () => {
  test("a verdict records the model that actually answered after a rate-limit fallback", async () => {
    const llm = new MockLLM([(args) => {
      if (args.model === PRIMARY) throw rateLimited();
      return answer(args);
    }]);
    const verdicts = await withConfig({ JUDGE_MODEL_FALLBACK: FALLBACK }, () =>
      quietly(() => evaluateIngestedSession(agentConfig(), events, llm, "livekit")),
    );
    const llmRows = buildExternalEvalRows(verdicts).filter((r) => !CODE_DERIVED.has(r.judgeName));
    expect(llmRows.map((r) => r.judgeName).sort()).toEqual([
      "bot_detection", "call_screening", "do_not_disturb", "hallucination", "instructions_adherence",
      "intent_identification", "low_engagement", "node_loop", "user_sentiment", "variable_extraction",
      "voicemail_detection", "wrong_number",
    ]);
    for (const row of llmRows) {
      expect({ judge: row.judgeName, model: row.raw.judge_model, effort: row.raw.reasoning_effort })
        .toEqual({ judge: row.judgeName, model: FALLBACK, effort: "none" });
    }
  });

  test("a verdict no LLM call decided carries no model", async () => {
    const verdicts = await evaluateIngestedSession(
      agentConfig({ instructions: "", intents: [], variables: [] }), events, new MockLLM([answer]), "livekit",
    );
    const rows = new Map(buildExternalEvalRows(verdicts).map((r) => [r.judgeName, r.raw]));
    for (const skipped of ["instructions_adherence", "intent_identification", "variable_extraction", "user_never_spoke"]) {
      expect({ skipped, provenance: Object.keys(rows.get(skipped)!).filter((k) => k.startsWith("judge_") || k === "prompt_sha256") })
        .toEqual({ skipped, provenance: [] });
    }
    expect(rows.get("hallucination")!.judge_model).toBe(PRIMARY);
  });

  test("a verdict built from several calls records each call's model", async () => {
    const llm = new MockLLM([(args) => {
      if (args.jsonSchema?.name === "eval_variable_guarded_review") {
        if (args.model === PRIMARY) throw rateLimited();
        return JSON.stringify({ reviews: [{
          variable_name: "order_id", issue_type: "missing", defect_confirmed: true, stored_value_supported: false, evidence: "It is 42.",
        }] });
      }
      if (args.jsonSchema?.name === "eval_variable") {
        return JSON.stringify({
          extraction_successful: false, score: 0, reason: "order id not recorded", technical_reason: "t",
          missing_variables: ["order_id"], incorrect_variables: [],
        });
      }
      return answer(args);
    }]);
    const verdicts = await withConfig({ JUDGE_MODEL_FALLBACK: FALLBACK }, () =>
      quietly(() => evaluateIngestedSession(agentConfig(), events, llm, "livekit")),
    );
    const variable = verdicts.node_evaluations[0]!.variable_extraction;
    expect(variable.extraction_successful).toBe(false);
    expect(variable.judge_model).toBe(PRIMARY);
    expect(variable.judge_calls?.map((c) => c.model)).toEqual([PRIMARY, FALLBACK]);
    expect(verdicts.node_evaluations[0]!.hallucination.judge_calls).toBeUndefined();
  });

  test("the session id reaches every judge call's usage line as its correlation id", async () => {
    const lines: string[] = [];
    const { log } = console;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[llm] usage")) lines.push(line);
    };
    try {
      const custom = { name: "metric:polite", display_name: "Polite", scope: "conversation" as const, body: "Fail if the agent is rude.", output: CUSTOM_METRIC_OUT };
      const llm = new MockLLM([(args) =>
        args.system.includes("Fail if the agent is rude")
          ? JSON.stringify({ situation_reached: true, unmet_required_criteria: [], verdict: "pass", reason: "r", technical_reason: "t" })
          : answer(args),
      ]);
      await evaluateIngestedSession(agentConfig(), events, llm, "livekit", undefined, undefined, [custom], undefined, "session-123");
      expect(lines).toHaveLength(llm.calls.length);
    } finally {
      console.log = log;
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain("correlation_id=session-123");
  });

  test("Jev-published verdicts carry no judge model; the LLM reviews beside them do", async () => {
    const verdicts = await evaluateIngestedSession(
      agentConfig(), events, new MockLLM([answer]), "livekit", undefined, undefined, [], new MockJev([{}], 0.01),
    );
    const voicemail = verdicts.conversation_metrics.voicemail_detected;
    expect(voicemail.backend).toBe("jev");
    expect(voicemail.judge_model).toBeUndefined();
    const hallucination = verdicts.node_evaluations[0]!.hallucination;
    expect(hallucination.backend).toBe("llm");
    expect(hallucination.judge_model).toBe(PRIMARY);
  });

  test("the deployed code revision is stamped only when one is configured", async () => {
    const judge = () => evaluateIngestedSession(agentConfig(), events, new MockLLM([answer]), "livekit");
    const stamped = await withConfig({ GIT_SHA: "rev-abc123" }, judge);
    expect(stamped.node_evaluations[0]!.hallucination.code_rev).toBe("rev-abc123");
    const unstamped = await judge();
    expect("code_rev" in unstamped.node_evaluations[0]!.hallucination).toBe(false);
  });
});

describe("prompt version and hash", () => {
  const ctx = (transcript: string): ConversationInput => ({
    flow_name: "orders", global_prompt: "g", nodes: [], goals: [], full_transcript: transcript,
  });
  const custom = (body: string) => ({ name: "metric:polite", display_name: "Polite", scope: "conversation" as const, body, output: CUSTOM_METRIC_OUT });
  const customVerdict = async (body: string, transcript: string) => {
    const llm = new MockLLM([JSON.stringify({ situation_reached: true, unmet_required_criteria: [], verdict: "pass", reason: "r", technical_reason: "t" })]);
    const [verdict] = await runCustomMetricJudges([custom(body)], ctx(transcript), () => "", llm);
    return { version: verdict!.prompt_version, hash: verdict!.prompt_sha256 };
  };
  const SLOTTED = ["instructions_adherence", "intent_identification", "variable_extraction"];
  const nodeRows = async (node: Record<string, unknown>, transcript: StoredEvent[]) => {
    const verdicts = await evaluateIngestedSession(agentConfig(node), transcript, new MockLLM([answer]), "livekit");
    return new Map(buildExternalEvalRows(verdicts).map((r) => [r.judgeName, r.raw]));
  };

  test("one judge version shares a prompt version across sessions whose rendered prompts differ", async () => {
    const a = await nodeRows({}, events);
    const b = await nodeRows({
      instructions: "Greet the caller and book a table.",
      intents: [{ name: "book_table", description: "the caller wants a reservation" }],
      variables: [{ name: "party_size", rule: "Record how many guests the caller states." }],
    }, [
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "How many guests?" } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "user", content: "Four." } },
    ]);
    for (const judge of [...SLOTTED, "hallucination", "node_loop"]) {
      expect({ judge, version: a.get(judge)!.prompt_version }).toEqual({ judge, version: b.get(judge)!.prompt_version });
      expect(a.get(judge)!.prompt_version).toMatch(/^[0-9a-f]{16}$/);
    }
    for (const judge of SLOTTED) expect({ judge, same: a.get(judge)!.prompt_sha256 === b.get(judge)!.prompt_sha256 }).toEqual({ judge, same: false });
  });

  test("editing a judge's registry body changes its prompt version", async () => {
    const before = await nodeRows({}, events);
    setJudgePromptOverrides(new Map([["instructions_adherence", { body: `${INSTRUCTION_ADHERENCE}\nBe strict.`, output: OUT_INSTRUCTION }]]));
    try {
      const after = await nodeRows({}, events);
      expect(after.get("instructions_adherence")!.prompt_version).not.toBe(before.get("instructions_adherence")!.prompt_version);
      expect(after.get("hallucination")!.prompt_version).toBe(before.get("hallucination")!.prompt_version);
    } finally {
      clearJudgePromptOverrides();
    }
  });

  test("a custom judge edited in place changes its version and hash; judging another call changes neither", async () => {
    const original = await customVerdict("Fail if the agent is rude.", "Agent: Hello\nUser: Hi");
    expect(original.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await customVerdict("Fail if the agent is rude.", "Agent: Good morning\nUser: Who is this?")).toEqual(original);
    const edited = await customVerdict("Fail if the agent is rude or curt.", "Agent: Hello\nUser: Hi");
    expect(edited.version).not.toBe(original.version);
    expect(edited.hash).not.toBe(original.hash);
  });

  test("version and hash both cover the output schema sent with the prompt", async () => {
    const Ok = z.object({ ok: z.boolean() });
    const call = async (properties: Record<string, unknown>) => {
      const { calls } = await runLlmJudge({
        system: "Judge politeness.", input: "Agent: Hello", schema: Ok, maxTokens: 100,
        jsonSchema: { name: "eval_polite", strict: true, schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } },
        provider: new MockLLM([JSON.stringify({ ok: true, why: "" })]),
      });
      return { version: calls[0]!.prompt_version, hash: calls[0]!.prompt_sha256 };
    };
    const base = await call({ ok: { type: "boolean" } });
    expect(await call({ ok: { type: "boolean" } })).toEqual(base);
    const changed = await call({ why: { type: "string" }, ok: { type: "boolean" } });
    expect(changed.version).not.toBe(base.version);
    expect(changed.hash).not.toBe(base.hash);
  });

  test("the hash is of the system prompt the provider received, JSON-only hint included", async () => {
    const llm = new MockLLM([JSON.stringify({ ok: true })]);
    const jsonSchema = { name: "eval_polite", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
    const { calls } = await runLlmJudge({ system: "Judge politeness.", input: "Agent: Hello", schema: z.object({ ok: z.boolean() }), maxTokens: 100, jsonSchema, provider: llm });
    const sent = llm.calls[0]!;
    expect(sent.system.endsWith(systemPromptAsSent(undefined))).toBe(true);
    expect(calls[0]!.prompt_sha256).toBe(createHash("sha256").update(JSON.stringify([sent.system, sent.jsonSchema])).digest("hex"));
    // With no per-call slots the version is the sent prompt's hash, so editing the hint moves it.
    expect(calls[0]!.prompt_version).toBe(calls[0]!.prompt_sha256.slice(0, 16));
  });
});
