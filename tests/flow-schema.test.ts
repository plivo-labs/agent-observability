import { describe, test, expect } from "bun:test";
import { CanonicalFlow } from "../src/simulation/flow/flow-schema.js";

// The CanonicalFlow Zod schema is the fixed, authoritative envelope. It is STRICT
// on the structure the orchestrator depends on (a node needs id+type; there must
// be at least one node) but LENIENT (.passthrough) on open-ended node config and
// unknown node types — it must never reject a valid-but-unfamiliar flow.

describe("CanonicalFlow — strict envelope", () => {
  test("requires at least one node", () => {
    const r = CanonicalFlow.safeParse({ nodes: [], edges: [] });
    expect(r.success).toBe(false);
  });

  test("rejects a node missing id or type", () => {
    expect(CanonicalFlow.safeParse({ nodes: [{ type: "start" }] }).success).toBe(false);
    expect(CanonicalFlow.safeParse({ nodes: [{ id: "n1" }] }).success).toBe(false);
  });

  test("defaults edges to [] and systemPrompt to ''", () => {
    const r = CanonicalFlow.parse({ nodes: [{ id: "n1", type: "start" }] });
    expect(r.edges).toEqual([]);
    expect(r.systemPrompt).toBe("");
  });
});

describe("CanonicalFlow — lenient config + unknown types", () => {
  test("accepts an unknown node type", () => {
    const r = CanonicalFlow.safeParse({ nodes: [{ id: "n1", type: "brand_new_node_type" }] });
    expect(r.success).toBe(true);
  });

  test("passthrough keeps unmodeled node fields and config keys", () => {
    const r = CanonicalFlow.parse({
      nodes: [{ id: "n1", type: "ai_agent_v2", data: { config: { name: "x", custom_field: 42 } }, ui_only: true }],
    });
    const node = r.nodes[0] as unknown as Record<string, any>;
    expect(node.data.config.custom_field).toBe(42);
    // .passthrough() preserves the extra top-level node field too
    expect(node.ui_only).toBe(true);
  });

  test("accepts both systemPrompt spellings (string and {prompt} object)", () => {
    expect(CanonicalFlow.parse({ nodes: [{ id: "n", type: "start" }], systemPrompt: "hi" }).systemPrompt).toBe("hi");
    const obj = CanonicalFlow.parse({
      nodes: [{ id: "n", type: "start" }],
      systemPrompt: { prompt: "hi", all_nodes_enabled: true },
    }).systemPrompt;
    expect(typeof obj === "object" && obj.prompt).toBe("hi");
  });

  test("tolerates config at either data.config or a flat config (pre-normalize)", () => {
    const r = CanonicalFlow.safeParse({
      nodes: [
        { id: "a", type: "ai_agent_v2", data: { config: { name: "a" } } },
        { id: "b", type: "ai_agent_v2", config: { name: "b" } },
      ],
    });
    expect(r.success).toBe(true);
  });
});
