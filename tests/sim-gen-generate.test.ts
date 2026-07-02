import { describe, test, expect, mock } from "bun:test";

mock.module("../src/config.js", () => ({
  config: { LLM_PROVIDER: "anthropic", JUDGE_MODEL: undefined, SIMULATOR_MODEL: undefined, GENERATOR_MODEL: undefined, LLM_TIMEOUT_MS: 30000, LLM_MAX_RETRIES: 1 },
}));

const { generateScenarios } = await import("../src/sim-engine/gen/generate.js");
const { MockLLM } = await import("../src/llm/index.js");
const { normalizeFlow } = await import("../src/simulation/flow/flow-normalize.js");
const realShape = (await import("./fixtures/flow-real-shape.json")).default;
import type { GenEvent } from "../src/sim-engine/gen/generate.js";
import type { ProviderCompleteArgs } from "../src/sim-engine/../llm/types.js";

const canonical = normalizeFlow(realShape) as unknown as Record<string, any>;

const PLANNER_JSON = JSON.stringify({
  agent_flow_description: "Refund agent.",
  capabilities: [
    { capability_id: "handle_refund", name: "Handle refund", description: "d", priority: "core", risk: "high", source_signals: ["s"], success_criteria: ["sc"], route_anchors: [{ source_node_id: "n-greet", intent_name: "wants_refund", target_node_type: "branch_v2", support: "fully_executable" }], action_anchors: [], variable_anchors: ["order_id"], recommended_conversation_patterns: [], boundary_patterns: [] },
    { capability_id: "handle_status", name: "Handle status", description: "d", priority: "core", risk: "medium", source_signals: ["s"], success_criteria: ["sc"], route_anchors: [{ source_node_id: "n-greet", intent_name: "check_status", target_node_type: "ai_agent_v2", support: "fully_executable" }], action_anchors: [], variable_anchors: [], recommended_conversation_patterns: [], boundary_patterns: [] },
  ],
  planner_rationale: "r",
});

// Adaptive writer: returns one valid scenario per requested slot_id.
const writerResponder = (args: ProviderCompleteArgs): string => {
  const payload = JSON.parse(args.user);
  const items = (payload.expected_slot_ids as string[]).map((id) => ({
    slot_id: id,
    scenario: { name: `Scenario ${id}`, persona: { personality: "", emotional_state: "", behavioral_traits: [], details_json: "{}" }, goal: `Goal for ${id}`, language: "en-US", world_state: [], start_node_params_json: "{}", tags: [] },
  }));
  return JSON.stringify({ agent_flow_description: "Refund agent.", scenario_items: items });
};

async function collect(gen: AsyncGenerator<GenEvent>): Promise<GenEvent[]> {
  const out: GenEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("generateScenarios — full pipeline (MockLLM planner+writer, real allocator)", () => {
  test("emits ordered progress events + N scenarios with eval_metadata; coverage_keys unique", async () => {
    const events = await collect(
      generateScenarios({
        flowJson: canonical,
        phloUuid: "agent-1",
        maxScenarios: 4,
        model: "gpt-5.5-1",
        plannerProvider: new MockLLM([PLANNER_JSON]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    const types = events.map((e) => e.type);
    // ordered phase markers
    expect(types.indexOf("planning_started")).toBeLessThan(types.indexOf("planning_done"));
    expect(types.indexOf("planning_done")).toBeLessThan(types.indexOf("allocation_started"));
    expect(types.indexOf("allocation_done")).toBeLessThan(types.indexOf("writing_started"));
    expect(types.indexOf("writing_started")).toBeLessThan(types.indexOf("scenario"));
    expect(types[types.length - 1]).toBe("metadata");

    const scenarios = events.filter((e) => e.type === "scenario").map((e) => (e as any).scenario);
    expect(scenarios.length).toBe(4);
    for (const s of scenarios) {
      expect(s.eval_metadata.coverage_key).toBeTruthy();
      expect(s.world_state).toBeDefined();
    }
    const keys = scenarios.map((s) => s.eval_metadata.coverage_key);
    expect(new Set(keys).size).toBe(keys.length); // deduped / unique

    const meta = events.find((e) => e.type === "metadata") as any;
    expect(meta.metadata.saved_count).toBe(4);
    expect(meta.metadata.failed_slot_ids).toEqual([]);
    expect(meta.metadata.partial_success).toBe(false);
  });

  test("throws after the planner fails twice", async () => {
    const run = collect(
      generateScenarios({
        flowJson: canonical,
        phloUuid: "a",
        maxScenarios: 4,
        model: "gpt-5.5-1",
        plannerProvider: new MockLLM(["nope", "still nope"]),
        writerProvider: new MockLLM([writerResponder]),
      }),
    );
    await expect(run).rejects.toThrow(/Planner failed/);
  });
});
