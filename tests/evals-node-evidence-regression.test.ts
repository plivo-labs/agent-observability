import { expect, mock, test } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";
mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);
const { buildSessionEvalInput } = await import("../src/evals-engine/integration/session-evals.js");
const { nodePayload } = await import("../src/evals-engine/judges/node-judge-payload.js");
const { buildJevPlan } = await import("../src/evals-engine/jev/plan.js");
import type { AgentConfig, StoredEvent } from "../src/evals-engine/integration/session-evals.js";

const config: AgentConfig = { nodes: ["collect", "confirm", "finish"].map(ref => ({
  ref, name: ref, instructions: "Collect and confirm the preferred time.",
  variables: [{ name: "time", tool: "record_time", rule: "Preserve the latest confirmed time." }],
})) };
const speech = (node_ref: string, role: string, content: string): StoredEvent => ({
  type: "conversation_item_added", node_ref, item: { type: "message", role, content },
});
const write = (node_ref: string, value: string): StoredEvent => ({
  type: "conversation_item_added", node_ref, item: { type: "function_call", name: "record_time", arguments: { value } },
});

test("node judges see each event once, preserve revisits, and exclude later-node accusations (B01/D05)", () => {
  const { input } = buildSessionEvalInput(config, [
    speech("collect", "assistant", "What time works?"),
    speech("confirm", "user", "Seven please."),
    speech("collect", "assistant", "I have seven recorded."),
    speech("finish", "assistant", "Your order is processing."),
  ]);
  const payload = nodePayload(input.nodes[0], input);
  const evidence = JSON.stringify([payload.node_transcript, payload.conversation_history]);
  expect(evidence.match(/What time works/g)).toHaveLength(1);
  expect(evidence.match(/I have seven recorded/g)).toHaveLength(1);
  expect(evidence).not.toContain("Your order is processing");
  expect(payload.target_node_uuid).toBe("collect");
  expect(payload.conversation_history).toContain("node confirm");
  expect(payload.node_transcript).toContain("event 2");
  expect(payload.chronology_available).toBe(true);
  // Both backends receive the same scope, before Jev's tool-output clipping.
  const state = buildJevPlan(input).requests.find(r => r.key === "n0")!.state as any;
  expect(state.node_transcript).toBe(payload.node_transcript);
  expect(state.conversation_history).toBe(payload.conversation_history);
});

test("extraction uses the latest write at node exit, never a future correction (D13/D14)", () => {
  const { input } = buildSessionEvalInput(config, [
    speech("collect", "user", "Six, actually seven."),
    write("collect", "18:00"), write("collect", "19:00"),
    speech("confirm", "user", "Change that to eight."), write("confirm", "20:00"),
    speech("finish", "assistant", "Thank you."),
  ]);
  expect(input.nodes.map(n => n.extracted_variables.time)).toEqual(["19:00", "20:00", "20:00"]);
  expect(JSON.stringify(nodePayload(input.nodes[0], input))).not.toContain("Change that to eight");
});

test("an earlier empty extraction cannot borrow a value first recorded downstream", () => {
  const { input } = buildSessionEvalInput(config, [
    speech("collect", "user", "Seven."),
    speech("confirm", "user", "Eight."), write("confirm", "20:00"),
  ]);
  expect(input.nodes[0].extracted_variables).toEqual({});
  expect(input.nodes[1].extracted_variables).toEqual({ time: "20:00" });
});

test("failed writes cannot replace successful values; unconfirmed attempts stay labelled", () => {
  const result = (is_error: boolean): StoredEvent => ({ type: "conversation_item_added", node_ref: "collect",
    item: { type: "function_call_output", name: "record_time", output: "", is_error } });
  const { input } = buildSessionEvalInput(config, [
    write("collect", "19:00"), result(false), write("collect", "20:00"), result(true),
  ]);
  expect(input.nodes[0].extracted_variables).toEqual({ time: "19:00" });
  expect(input.nodes[0].variable_sources?.time.status).toBe("succeeded");
  expect(input.full_transcript).toContain("[tool failed]");
  const pending = buildSessionEvalInput(config, [write("collect", "21:00")]).input.nodes[0];
  expect(pending.variable_sources?.time.status).toBe("unconfirmed");
});

test("call IDs disambiguate concurrent writes and a failed handoff is not selected", () => {
  const call = (id: string, value: string): StoredEvent => ({ ...write("collect", value),
    item: { ...write("collect", value).item, call_id: id } });
  const output = (call_id: string, is_error: boolean): StoredEvent => ({ type: "conversation_item_added", node_ref: "collect",
    item: { type: "function_call_output", call_id, name: "record_time", output: "", is_error } });
  const { input } = buildSessionEvalInput(config, [call("one", "19:00"), call("two", "20:00"), output("two", true), output("one", false)]);
  expect(input.nodes[0].extracted_variables).toEqual({ time: "19:00" });
  const intents: AgentConfig = { nodes: [{ ref: "collect", intents: [{ name: "transfer", tool: "record_time" }] }] };
  expect(buildSessionEvalInput(intents, [call("one", "19:00"), output("one", true)]).input.nodes[0].chosen_intent).toBe("");
});

test("intent questions cover the full catalog, not one missing-tool question per intent", () => {
  const longRule = "Customer requests the special route. ".repeat(20);
  const cfg: AgentConfig = { nodes: [{ ref: "collect", intents: Array.from({ length: 20 }, (_, i) => ({ name: `route_${i}`, description: longRule })) }] };
  const { input } = buildSessionEvalInput(cfg, [speech("collect", "user", "Please send me to the special route.")]);
  const plan = buildJevPlan(input);
  const axis = plan.axes.find(a => a.judge === "intent_identification")!;
  expect(axis.questionKeys).toEqual(["n0.intent.not_found", "n0.intent.wrong"]);
  expect("truncated" in axis && axis.truncated).toBeFalsy();
  const request = plan.requests.find(r => r.key === axis.requestKey)!;
  expect((request.state as any).available_intents).toHaveLength(20);
  expect((request.state as any).available_intents[19].description).toBe(longRule);
  expect((request.state as any).chosen_intent).toBe("");
});

test("actual LLM provider inputs keep target speech single and retain the shared rubric", async () => {
  const { MockLLM } = await import("../src/llm/index.js");
  const { runHallucinationJudge, runLoopJudge } = await import("../src/evals-engine/judges/node-judges.js");
  const { runIntentJudge } = await import("../src/evals-engine/judges/intent-judge.js");
  const { INTENT_CONTRACT } = await import("../src/evals-engine/judge-contracts.js");
  const cfg: AgentConfig = { nodes: [{ ref: "collect", intents: [{ name: "booking", description: "Caller wants to book." }] }, { ref: "finish" }] };
  const { input } = buildSessionEvalInput(cfg, [
    speech("collect", "user", "Please book."), speech("collect", "assistant", "What time?"),
    speech("finish", "assistant", "Your payment is complete."),
  ]);
  const llm = new MockLLM([
    JSON.stringify({ hallucinated: false, score: 1, reason: "no claim", technical_reason: "none" }),
    JSON.stringify({ loop_detected: false, score: 1, reason: "one question", technical_reason: "none" }),
    JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "covered", technical_reason: "no selection recorded" }),
  ]);
  await runHallucinationJudge(input.nodes[0], input, llm);
  await runLoopJudge(input.nodes[0], input, llm);
  await runIntentJudge(input.nodes[0], input, llm);
  for (const call of llm.calls) {
    expect(call.user.match(/What time\?/g)).toHaveLength(1);
    expect(call.user).not.toContain("Your payment is complete");
  }
  expect(llm.calls[2].system).toContain(INTENT_CONTRACT);
});
