import { describe, test, expect } from "bun:test";

// flow-summary is a pure leaf (inventory + json helpers only — no config import),
// so no config mock is needed, mirroring sim-gen-inventory.test.ts.
import {
  buildSmokeFlowSummary,
  resolvePlannerPayload,
  SUMMARY_VERSION,
} from "../src/sim-engine/gen/flow-summary.js";
import { buildFlowInventory } from "../src/sim-engine/gen/inventory.js";
import { plannerCacheKey } from "../src/sim-engine/gen/planner-cache.js";
import { normalizeFlow } from "../src/simulation/flow/flow-normalize.js";
import realShape from "./fixtures/flow-real-shape.json";

const canonical = normalizeFlow(realShape) as unknown as Record<string, any>;

describe("buildSmokeFlowSummary — the fixture flow", () => {
  const summary = buildSmokeFlowSummary(canonical);

  test("agent_profile carries the flow_json-only globals", () => {
    expect(summary.summary_version).toBe(SUMMARY_VERSION);
    expect(summary.agent_profile.system_prompt).toBe("You are Acme support. Be concise.");
    expect(summary.agent_profile.stt_guidance).toBe("Expect spoken order numbers.");
    expect(summary.agent_profile.flow_name).toBe("real-shape-flow");
    expect(summary.agent_profile.knowledge_base.global_count).toBe(1);
    expect(summary.agent_profile.knowledge_base.node_ids_with_kb).toEqual(["n-refund"]);
  });

  test("edge_topology carries EVERY edge with intent handles resolved", () => {
    expect(summary.edge_topology.length).toBe(8); // all 8 fixture edges, incl. non-intent ones
    const byKey = new Map(summary.edge_topology.map((e) => [`${e.source}>${e.target}`, e]));
    // Intent edge: UUID handle resolved to the intent name.
    expect(byKey.get("n-greet>n-check")).toMatchObject({ kind: "intent", intent_name: "wants_refund" });
    // Structural (branch outcome) edges — invisible to the route inventory, present here.
    expect(byKey.get("n-check>n-notify")).toMatchObject({ kind: "flow", handle: "eligible" });
    expect(byKey.get("n-check>n-bye")).toMatchObject({ kind: "flow", handle: "no_match" });
    expect(byKey.get("n-notify>n-http")).toMatchObject({ kind: "flow", handle: "success" });
  });

  test("node_digests cover non-agent nodes only (agent nodes live in the inventory)", () => {
    const ids = summary.node_digests.map((d) => d.id);
    expect(ids).toEqual(["n-bye", "n-check", "n-http", "n-notify"]); // sorted; no n-greet/n-refund/n-start
    const check = summary.node_digests.find((d) => d.id === "n-check")!;
    expect(check.type).toBe("branch_v2");
    expect(check.name).toBe("eligibility_check");
    expect(check.config_keys).toContain("name");
  });

  test("start_node keeps triggers (keys-only inventory loses them)", () => {
    expect(summary.start_node.triggers).toEqual(["voice"]);
    expect(summary.start_node.payload_format).toEqual({});
  });

  test("does NOT duplicate agent-node instructions (that's the bulk being cut)", () => {
    const s = JSON.stringify(summary);
    expect(s).not.toContain("Greet the caller");
    expect(s).not.toContain("Process the refund");
  });

  test("deterministic: two builds are byte-identical", () => {
    expect(JSON.stringify(buildSmokeFlowSummary(canonical))).toBe(JSON.stringify(summary));
  });

  test("is materially smaller than the flow it summarizes", () => {
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(canonical).length);
  });
});

describe("buildSmokeFlowSummary — synthetic shapes", () => {
  test("action_params exposes schema property names by mock_key", () => {
    const flow = {
      nodes: [
        {
          id: "n1",
          type: "ai_agent_v2",
          data: {
            config: {
              name: "agent",
              actions: [
                {
                  action_type: "EXECUTE_ACTION",
                  action_name: "issue_refund",
                  action_instructions: "refund the order",
                  action_schema: { type: "object", properties: { order_id: { type: "string" }, amount: { type: "number" } } },
                },
              ],
            },
          },
        },
      ],
      edges: [],
    };
    const summary = buildSmokeFlowSummary(flow);
    expect(summary.action_params).toEqual({ issue_refund: ["amount", "order_id"] });
  });

  test("unknown node types degrade to a generic digest with a capped excerpt", () => {
    const bigConfig: Record<string, string> = { name: "mystery" };
    for (let i = 0; i < 50; i++) bigConfig[`k${i}`] = "x".repeat(40);
    const flow = { nodes: [{ id: "nx", type: "some_future_node", data: { config: bigConfig } }], edges: [] };
    const digest = buildSmokeFlowSummary(flow).node_digests[0];
    expect(digest.type).toBe("some_future_node");
    expect(digest.config_keys).toContain("k0");
    expect((digest.config_excerpt as string).length).toBeLessThanOrEqual(500);
  });

  test("prompt nodes surface their spoken text", () => {
    const flow = {
      nodes: [{ id: "np", type: "prompt", data: { config: { name: "notify", text: "Your refund is on its way." } } }],
      edges: [],
    };
    expect(buildSmokeFlowSummary(flow).node_digests[0].text).toBe("Your refund is on its way.");
  });
});

describe("resolvePlannerPayload — the degenerate-flow guard", () => {
  test("flag off → full payload, reason flag_off", () => {
    const resolved = resolvePlannerPayload(canonical, buildFlowInventory(canonical), false);
    expect(resolved).toEqual({ variant: "full", reason: "flag_off" });
  });

  test("the fixture flow → summary (has routes, summary is smaller)", () => {
    const resolved = resolvePlannerPayload(canonical, buildFlowInventory(canonical), true);
    expect(resolved.variant).toBe("summary");
    expect(resolved.reason).toBe("on");
    // The union guarantees the summary arm carries its summary — narrow to read it.
    if (resolved.variant === "summary") expect(resolved.summary.summary_version).toBe(SUMMARY_VERSION);
  });

  test("flow with zero intent routes (edge-driven routing) → full, degenerate_no_routes", () => {
    const flow = {
      nodes: [
        { id: "s", type: "start", data: { config: { name: "Start" } } },
        { id: "p", type: "prompt", data: { config: { name: "say" } } },
      ],
      edges: [{ id: "e", source: "s", target: "p", sourceHandle: "success" }],
    };
    const resolved = resolvePlannerPayload(flow, buildFlowInventory(flow), true);
    expect(resolved).toEqual({ variant: "full", reason: "degenerate_no_routes" });
    // Zero routes with zero edges is equally degenerate — same fallback.
    const edgeless = { nodes: [{ id: "a", type: "prompt", data: { config: { name: "p" } } }], edges: [] };
    expect(resolvePlannerPayload(edgeless, buildFlowInventory(edgeless), true)).toEqual({
      variant: "full",
      reason: "degenerate_no_routes",
    });
  });

  test("tiny flow with a route where the summary is not smaller → full, summary_not_smaller", () => {
    // Has a real intent route (so it passes the route guard) but is so small that the
    // summary scaffolding outweighs the flow itself.
    const flow = {
      nodes: [
        { id: "a", type: "ai_agent_v2", data: { config: { name: "x", intents: [{ id: "i1", intent_name: "go" }] } } },
        { id: "b", type: "end_conversation", data: { config: { name: "bye" } } },
      ],
      edges: [{ id: "e", source: "a", target: "b", sourceHandle: "i1" }],
    };
    const inventory = buildFlowInventory(flow);
    expect(inventory.routes.length).toBe(1);
    const resolved = resolvePlannerPayload(flow, inventory, true);
    expect(resolved).toEqual({ variant: "full", reason: "summary_not_smaller" });
  });
});

describe("planner cache key — payload-shape safety", () => {
  test("flag flips and summary-version bumps change the key", () => {
    const base = {
      flowJson: canonical,
      phloUuid: "a",
      model: "m",
      simulationMode: "smoke" as const,
      smokeCap: 20,
      instructions: "",
      existingSummaries: [],
      smokeFlowSummary: false,
      summaryVersion: SUMMARY_VERSION,
    };
    const off = plannerCacheKey(base);
    const on = plannerCacheKey({ ...base, smokeFlowSummary: true });
    const bumped = plannerCacheKey({ ...base, smokeFlowSummary: true, summaryVersion: SUMMARY_VERSION + 1 });
    expect(on).not.toBe(off);
    expect(bumped).not.toBe(on);
    expect(plannerCacheKey(base)).toBe(off); // deterministic
  });
});
