import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

// Mock config so importing the llm module (via the judges) doesn't parse real env.
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const { MockLLM } = await import("../src/llm/index.js");
const { runCustomMetricJudges, rollUpNodeVerdicts, CUSTOM_METRIC_OUT, customJudgeName } = await import(
  "../src/evals-engine/judges/custom-metric.js"
);
const { buildExternalEvalRows } = await import("../src/evals-engine/fan-out-rows.js");
const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
type ConversationInput = import("../src/evals-engine/types.js").ConversationInput;
type CustomJudgeSpec = import("../src/evals-engine/judges/custom-metric.js").CustomJudgeSpec;
type SessionEvalVerdicts = import("../src/evals-engine/integration/session-evals.js").SessionEvalVerdicts;

const spec = (over: Partial<CustomJudgeSpec> = {}): CustomJudgeSpec => ({
  name: "metric:insurance_verified",
  display_name: "Insurance verified",
  scope: "conversation",
  body: "Fail if slots are offered before the member ID is confirmed.",
  output: CUSTOM_METRIC_OUT,
  ...over,
});

const ctx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "medibook",
  global_prompt: "Book appointments.",
  nodes: [
    {
      node_uuid: "n1", node_name: "collect_insurance", node_prompt: "Collect carrier and member id.",
      available_intents: [], chosen_intent: "", required_variables: [], extracted_variables: {},
      turns: [{ node_uuid: "n1", user: "BlueCross", agent: "Great, Tuesday at 10?", intent: "" }],
      turn_count: 1,
    },
    {
      node_uuid: "n2", node_name: "offer_slots", node_prompt: "Offer slots.",
      available_intents: [], chosen_intent: "", required_variables: [], extracted_variables: {},
      turns: [{ node_uuid: "n2", user: "ok", agent: "Booked.", intent: "" }],
      turn_count: 1,
    },
  ],
  goals: [],
  full_transcript: "User: BlueCross\nAgent: Great, Tuesday at 10?",
  ...over,
});

const verdictJson = (verdict: string, reason = "r") =>
  JSON.stringify({ verdict, reason, technical_reason: "t" });

describe("custom metric judge", () => {
  test("slug: display name → metric:<slug>", () => {
    expect(customJudgeName("Insurance verified before booking!")).toBe("metric:insurance_verified_before_booking");
  });

  test("conversation scope: one call, system = body+output, speech transcript preferred", async () => {
    const llm = new MockLLM([verdictJson("fail", "slots before member id")]);
    const s = spec();
    const input = ctx({ speech_transcript: "User: BlueCross" });
    const [v] = await runCustomMetricJudges([s], input, llm);
    expect(v!.verdict).toBe("fail");
    expect(v!.available).toBe(true);
    expect(v!.judge_name).toBe("metric:insurance_verified");
    expect(llm.calls.length).toBe(1);
    expect(llm.calls[0]!.system.startsWith(s.body + s.output)).toBe(true);
    expect(JSON.parse(llm.calls[0]!.user).conversation_history).toBe("User: BlueCross");
  });

  test("node scope: one call per node, per-node verdicts + rolled-up summary and fail wins", async () => {
    const llm = new MockLLM([
      (args: any) => verdictJson(JSON.parse(args.user).node_name === "collect_insurance" ? "fail" : "pass"),
    ]);
    const [v] = await runCustomMetricJudges([spec({ scope: "node" })], ctx(), llm);
    expect(llm.calls.length).toBe(2);
    expect(v!.verdict).toBe("fail");
    expect(v!.per_node!.map((n) => [n.node_name, n.verdict])).toEqual([
      ["collect_insurance", "fail"],
      ["offer_slots", "pass"],
    ]);
  });

  test("roll-up: unknowns never mask a pass; all-unknown stays unknown", () => {
    const n = (verdict: "pass" | "fail" | "unknown") =>
      ({ ref: "r", node_name: "n", verdict, reason: "", technical_reason: "" });
    expect(rollUpNodeVerdicts([n("unknown"), n("pass")])).toBe("pass");
    expect(rollUpNodeVerdicts([n("unknown"), n("unknown")])).toBe("unknown");
    expect(rollUpNodeVerdicts([n("pass"), n("fail")])).toBe("fail");
  });

  test("deterministic judge failure → unavailable verdict, never a throw", async () => {
    const llm = new MockLLM(["not json at all", "not json at all", "not json at all"]);
    const [v] = await runCustomMetricJudges([spec()], ctx(), llm);
    expect(v!.available).toBe(false);
    expect(v!.verdict).toBe("unknown");
  });

  test("fan-out: pass/fail/unknown rows, node tags, unavailable skipped", () => {
    const base: SessionEvalVerdicts = {
      node_evaluations: [],
      conversation_metrics: {} as any,
      custom_metrics: [
        { judge_name: "metric:a", display_name: "A", scope: "conversation", verdict: "unknown", reason: "never reached", technical_reason: "t", available: true },
        { judge_name: "metric:b", display_name: "B", scope: "conversation", verdict: "pass", reason: "", technical_reason: "t", available: true },
        { judge_name: "metric:broken", display_name: "X", scope: "conversation", verdict: "unknown", reason: "", technical_reason: "judge unavailable", available: false },
        {
          judge_name: "metric:c", display_name: "C", scope: "node", verdict: "fail", reason: "", technical_reason: "t", available: true,
          per_node: [
            { ref: "n1", node_name: "collect_insurance", verdict: "fail", reason: "", technical_reason: "t" },
            { ref: "n2", node_name: "offer_slots", verdict: "unknown", reason: "", technical_reason: "t" },
          ],
        },
      ],
    };
    const rows = buildExternalEvalRows(base).filter((r) => r.judgeName.startsWith("metric:"));
    expect(rows.map((r) => [r.judgeName, r.tag, r.passed, r.verdictText ?? null])).toEqual([
      ["metric:a", null, false, "unknown"],
      ["metric:b", null, true, null],
      ["metric:c", "n1", false, null],
      ["metric:c", "n2", false, "unknown"],
    ]);
  });

  test("evaluateIngestedSession: custom judges ride along without disturbing defaults; zero-custom omits the key", async () => {
    const responder = (args: any) => {
      const s = args.system as string;
      if (s.includes("Fail if slots are offered")) return verdictJson("fail");
      if (s.includes("fabricated information")) return JSON.stringify({ hallucinated: false, score: 1, reason: "", technical_reason: "" });
      if (s.includes("Variables expected to be extracted")) return JSON.stringify({ extraction_successful: true, score: 1, reason: "", technical_reason: "", missing_variables: [], incorrect_variables: [] });
      if (s.includes("repeat its own previous messages")) return JSON.stringify({ loop_detected: false, score: 1, reason: "", technical_reason: "" });
      if (s.includes("correct intent for the conversation segment")) return JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "", technical_reason: "" });
      if (s.includes("four-part rubric"))
        return JSON.stringify({
          objective_progress: { achieved: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
          procedure_compliance: { score: 1, missed_steps: [], reason_code: "", reason: "", technical_reason: "" },
          interaction_quality: { score: 1, issues: [], reason_code: "", reason: "", technical_reason: "" },
          policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
        });
      if (s.includes("Classify the user's sentiment")) return JSON.stringify({ sentiment: "neutral", reason: "r", technical_reason: "t" });
      if (s.includes("speech-to-text quality")) return JSON.stringify({ error_count: 0, recovered_count: 0, reason: "r", technical_reason: "t" });
      return JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
    };
    const cfg = {
      flow_name: "medibook",
      global_prompt: "Book appointments.",
      nodes: [{ ref: "node-A", name: "collect_insurance", instructions: "Collect carrier.", intents: [], variables: [] }],
    };
    const events = [
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "Carrier?" } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "user", content: "BlueCross" } },
    ];

    const withCustom = new MockLLM([responder]);
    const verdicts = await evaluateIngestedSession(cfg, events, withCustom, "livekit", undefined, [], [spec()]);
    expect(verdicts.custom_metrics!.length).toBe(1);
    expect(verdicts.custom_metrics![0]!.verdict).toBe("fail");
    expect(verdicts.node_evaluations.length).toBe(1);

    const withoutCustom = new MockLLM([responder]);
    const plain = await evaluateIngestedSession(cfg, events, withoutCustom, "livekit", undefined, []);
    expect("custom_metrics" in plain).toBe(false);
    // exactly one extra LLM call when the single conversation-scope custom judge runs
    expect(withCustom.calls.length).toBe(withoutCustom.calls.length + 1);
    // default judge inputs are untouched by the custom judge riding along
    expect(withCustom.calls.filter((c) => !c.system.includes("Fail if slots are offered")).map((c) => c.system).toSorted())
      .toEqual(withoutCustom.calls.map((c) => c.system).toSorted());
  });
});
