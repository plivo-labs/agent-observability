// Accounting-line tests for scenario generation.
//
// Split out of sim-gen-generate.test.ts, which covers the generation PIPELINE
// (ordering, dedup, retry economy, top-up). These cover its OBSERVABILITY output:
// the per-scenario, per-chunk and per-stage lines. Different failure mode, and
// keeping them here stops the pipeline suite drifting past a size worth scanning.

import { describe, test, expect, mock } from "bun:test";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => ({
  ...TEST_CONFIG_MODULE_DEFAULTS,
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

describe("generateScenarios — timing + token accounting lines", () => {
  /** Capture the `[sim-gen]` accounting lines a generation prints. */
  function captureGenLines(): { lines: string[]; restore: () => void } {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[sim-gen] ")) lines.push(line);
    };
    return { lines, restore: () => { console.log = original; } };
  }

  function fields(line: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [, k, v] of line.matchAll(/(\w+)=(\S+)/g)) out[k] = v;
    return out;
  }

  /**
   * A provider that answers like MockLLM but ALSO reports reasoning tokens.
   * MockLLM reports none, which makes a reasoning double-count bug undetectable —
   * `+= reasoningTokens ?? 0` silently adds zero — so the invariant that reasoning
   * is never summed into the total needs a provider that actually reports it.
   */
  const REASONING_USAGE = { promptTokens: 100, completionTokens: 40, totalTokens: 140, reasoningTokens: 25 };
  function reportingProvider(respond: (args: ProviderCompleteArgs) => string) {
    return {
      name: "reporting",
      complete: async (args: ProviderCompleteArgs) => ({ text: respond(args), usage: { ...REASONING_USAGE } }),
    };
  }

  async function generate(
    maxScenarios: number,
    providers?: { planner: any; writer: any },
  ): Promise<string[]> {
    const cap = captureGenLines();
    try {
      await collect(
        generateScenarios({
          flowJson: canonical,
          phloUuid: "agent-1",
          maxScenarios,
          model: "gpt-5.5-1",
          plannerProvider: providers?.planner ?? new MockLLM([PLANNER_JSON]),
          writerProvider: providers?.writer ?? new MockLLM([writerResponder]),
        }),
      );
    } finally {
      cap.restore();
    }
    return cap.lines;
  }

  test("emits one timestamped line per saved scenario, in emission order", async () => {
    const lines = await generate(12);
    const scenarioLines = lines.filter((l) => l.startsWith("[sim-gen] scenario "));
    const timing = fields(lines.find((l) => l.startsWith("[sim-gen] timing "))!);
    const saved = Number(timing.saved!.split("/")[0]);

    // One line per SAVED scenario — this is the per-scenario arrival curve for a
    // 12/30/50-scenario batch, and it must not drift from the ledger.
    expect(scenarioLines).toHaveLength(saved);

    const parsed = scenarioLines.map(fields);
    expect(parsed.map((f) => Number(f.index))).toEqual(parsed.map((_, i) => i));
    for (const f of parsed) {
      expect(f.slot_id).not.toBe("-");
      expect(Number(f.chunk)).toBeGreaterThanOrEqual(0);
    }
    // at_ms is measured from one clock and never goes backwards.
    const at = parsed.map((f) => Number(f.at_ms));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("delta_ms is the gap since the PREVIOUS scenario, so the deltas telescope", async () => {
    const lines = await generate(12);
    const parsed = lines.filter((l) => l.startsWith("[sim-gen] scenario ")).map(fields);
    expect(parsed.length).toBeGreaterThan(1);

    // The defining invariant of a correct delta chain: deltas are consecutive gaps
    // anchored at generation start, so they must telescope to the last arrival.
    //   delta[0] = at[0] - genStart, delta[i] = at[i] - at[i-1]  ⇒  Σ delta = at[last]
    // A stale anchor (forgetting to advance it) makes every delta an ABSOLUTE offset
    // instead, and the sum blows past at[last] — which checking only delta[0] misses,
    // because delta[0] is identical under both the correct and the broken version.
    const deltaSum = parsed.reduce((n, f) => n + Number(f.delta_ms), 0);
    expect(deltaSum).toBe(Number(parsed.at(-1)!.at_ms));
  });

  test("emits one per-chunk line whose saved counts reconcile with the total", async () => {
    const lines = await generate(12);
    const chunkLines = lines.filter((l) => l.startsWith("[sim-gen] chunk ")).map(fields);
    const timing = fields(lines.find((l) => l.startsWith("[sim-gen] timing "))!);

    expect(chunkLines.length).toBeGreaterThan(0);
    // Chunk is the finest granularity at which tokens are attributable, so its
    // bookkeeping has to add up to the generation ledger exactly.
    const chunkSaved = chunkLines.reduce((n, f) => n + Number(f.saved), 0);
    expect(chunkSaved).toBe(Number(timing.saved!.split("/")[0]));
    const chunkCalls = chunkLines.reduce((n, f) => n + Number(f.llm_calls), 0);
    expect(chunkCalls).toBe(Number(timing.writer_llm_calls));
    const chunkTokens = chunkLines.reduce((n, f) => n + Number(f.total_tokens), 0);
    expect(chunkTokens).toBe(
      Number(timing.writer_prompt_tokens) + Number(timing.writer_completion_tokens),
    );
  });

  test("splits tokens by stage and never folds reasoning into the total", async () => {
    const lines = await generate(12, {
      planner: reportingProvider(() => PLANNER_JSON),
      writer: reportingProvider(writerResponder),
    });
    const f = fields(lines.find((l) => l.startsWith("[sim-gen] timing "))!);

    // The planner is one call; the writer is one call per chunk. Keeping them apart
    // is the point — they have very different token profiles.
    expect(Number(f.planner_llm_calls)).toBe(1);
    expect(Number(f.writer_llm_calls)).toBeGreaterThanOrEqual(1);
    expect(Number(f.llm_calls)).toBe(Number(f.planner_llm_calls) + Number(f.writer_llm_calls));

    // Reasoning IS reported per stage...
    expect(Number(f.planner_reasoning_tokens)).toBe(REASONING_USAGE.reasoningTokens);
    expect(Number(f.writer_reasoning_tokens)).toBe(
      REASONING_USAGE.reasoningTokens * Number(f.writer_llm_calls),
    );
    // ...and is NEVER added to the total. It is a subset of completion tokens, which
    // the provider already counts inside output_tokens; summing it would inflate the
    // reported spend of every reasoning model.
    const calls = Number(f.llm_calls);
    expect(Number(f.total_tokens)).toBe(
      calls * (REASONING_USAGE.promptTokens + REASONING_USAGE.completionTokens),
    );
    expect(Number(f.total_tokens)).toBe(
      Number(f.planner_prompt_tokens) + Number(f.planner_completion_tokens) +
        Number(f.writer_prompt_tokens) + Number(f.writer_completion_tokens),
    );

    // The allocator is deliberately absent: it makes no LLM call, so it has no token
    // line to emit. Its cost is allocation_ms and nothing else.
    expect(f.allocation_ms).toBeDefined();
    expect(f.allocation_tokens).toBeUndefined();
  });
});

describe("generateScenarios — a replanned generation bills every planner call", () => {
  function captureGenLines(): { lines: string[]; restore: () => void } {
    const original = console.log, ow = console.warn;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { const l = a.map(String).join(" "); if (l.startsWith("[sim-gen] ")) lines.push(l); };
    console.warn = () => {};
    return { lines, restore: () => { console.log = original; console.warn = ow; } };
  }
  function fields(line: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [, k, v] of line.matchAll(/(\w+)=(\S+)/g)) out[k] = v;
    return out;
  }

  test("planner tokens include the rejected call, not just the survivor", async () => {
    // Regression guard for the 2026-08-05 smoke run: the first planner call was rejected
    // twice (20,470 tokens) and the outer loop replanned. `plannerUsage` holds only the
    // LAST call because that is the planner_usage metadata contract, so a roll-up reading
    // it reported 23,974 tokens against ~44,444 actually burned — a 46% under-report,
    // precisely on the runs that cost the most.
    //
    // First planner response is schema-invalid, so completeJSON exhausts its attempts and
    // throws; the second planner call succeeds.
    const badPlanner = new MockLLM([
      JSON.stringify({ nope: true }), JSON.stringify({ nope: true }),  // call 1: 2 rejected attempts
      PLANNER_JSON,                                                    // call 2 (replan): ok
    ]);
    const cap = captureGenLines();
    try {
      await collect(
        generateScenarios({
          flowJson: canonical, phloUuid: "agent-1", maxScenarios: 4, model: "m",
          plannerProvider: badPlanner, writerProvider: new MockLLM([writerResponder]),
        }),
      );
    } finally { cap.restore(); }

    const f = fields(cap.lines.find((l) => l.startsWith("[sim-gen] timing "))!);
    // 3 provider calls total (2 rejected attempts + 1 success) at the mock's 10p/5c each.
    expect(Number(f.planner_llm_calls)).toBe(2);          // two completeJSON invocations
    expect(Number(f.planner_prompt_tokens)).toBe(30);     // 3 attempts x 10 — the rejected ones counted
    expect(Number(f.planner_completion_tokens)).toBe(15);
  });
});
