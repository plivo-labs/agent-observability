import { describe, test, expect } from "bun:test";
import { normalizeFlow } from "../src/simulation/flow/flow-normalize.js";
import realShape from "./fixtures/flow-real-shape.json";
import storedShape from "./fixtures/flow-stored-shape.json";

// normalizeFlow folds ANY accepted shape into the single canonical form. The
// headline guarantee: the stored shape (Shape A: connections + flat config +
// global_meta.system_prompt + phlo) and the canonical shape (Shape B) for the
// SAME logical flow normalize to byte-identical nodes + edges.

describe("normalizeFlow — both shapes collapse to identical canonical", () => {
  const fromCanonical = normalizeFlow(realShape);
  const fromStored = normalizeFlow(storedShape);

  test("nodes are byte-identical across the two shapes", () => {
    expect(fromStored.nodes).toEqual(fromCanonical.nodes);
  });

  test("edges are byte-identical (connections split on the first dot, ids carried)", () => {
    expect(fromStored.edges).toEqual(fromCanonical.edges);
  });

  test("config always lands at data.config (canonical location)", () => {
    for (const n of fromStored.nodes) {
      expect(n.data?.config).toBeDefined();
    }
  });
});

describe("normalizeFlow — snake/camel global folding", () => {
  // Assert on the canonical object directly. The previous version read these via
  // flowGlobals() from the turn-loop agent-config module, which AO does not port
  // (the worker owns turns). normalizeFlow is what does the folding either way.
  const asRecord = (v: unknown) => v as Record<string, unknown> | undefined;

  test("global_meta.system_prompt (stored) and systemPrompt (canonical) carry the same prompt", () => {
    // stored folds global_meta.system_prompt → a plain string; canonical keeps the
    // { prompt, all_nodes_enabled } object. Both carry the same prompt text (this
    // extraction is what flowGlobals.globalPrompt used to do).
    const promptOf = (sp: unknown) =>
      typeof sp === "string" ? sp : (sp as { prompt?: string } | null)?.prompt;
    const n1 = normalizeFlow(storedShape);
    const n2 = normalizeFlow(realShape);
    expect(n1.systemPrompt).toBe("You are Acme support. Be concise.");
    expect(promptOf(n1.systemPrompt)).toEqual(promptOf(n2.systemPrompt));
  });

  test("phlo.voice_ai_config (stored) lifts into agentSettings.voice_ai_config", () => {
    const n = normalizeFlow(storedShape);
    const settings = asRecord((n as unknown as { agentSettings?: unknown }).agentSettings);
    expect((settings?.voice_ai_config as Record<string, unknown>)?.language).toBe("en-US");
  });

  test("snake_case agent_settings + system_prompt at the root also fold to camelCase", () => {
    const n = normalizeFlow({
      nodes: [{ id: "n", type: "ai_agent_v2", config: { name: "n" } }],
      system_prompt: "snaky",
      agent_settings: { stt_guidance: "watch numbers" },
    });
    expect(n.systemPrompt).toBe("snaky");
    const settings = asRecord((n as unknown as { agentSettings?: unknown }).agentSettings);
    expect(settings?.stt_guidance).toBe("watch numbers");
  });
});

describe("normalizeFlow — secret + UI-field stripping", () => {
  const n = normalizeFlow(storedShape);
  const byId = (id: string) => n.nodes.find((x) => x.id === id)!;

  test("strips auth_token from the start node config", () => {
    expect(byId("n-start").data?.config?.auth_token).toBeUndefined();
    // non-secret config survives
    expect(byId("n-start").data?.config?.triggers).toEqual(["voice"]);
  });

  test("strips password (and the http secret) from the http_request node", () => {
    expect(byId("n-http").data?.config?.password).toBeUndefined();
  });

  test("strips UI-only fields (position/measured/selected) off node config", () => {
    const cfg = byId("n-start").data?.config ?? {};
    expect(cfg.position).toBeUndefined();
    expect(cfg.measured).toBeUndefined();
    expect(cfg.selected).toBeUndefined();
  });
});

describe("normalizeFlow — unknown types pass through", () => {
  test("a brand-new node type is accepted, not rejected", () => {
    const n = normalizeFlow({
      nodes: [{ id: "x", type: "brand_new_node_type", data: { config: { name: "x" } } }],
    });
    expect(n.nodes[0].type).toBe("brand_new_node_type");
  });
});

describe("normalizeFlow — config.model wrapper unwrap + flat config", () => {
  test("unwraps { config: { model: { instructions, intents } } } to data.config", () => {
    const n = normalizeFlow({
      nodes: [
        { id: "x", type: "ai_agent_v2", config: { model: { instructions: "hi", intents: [{ id: "go", intent_name: "go" }] } } },
      ],
    });
    expect(n.nodes[0].data?.config?.instructions).toBe("hi");
  });
});

describe("normalizeFlow — idempotent", () => {
  test("normalizing an already-canonical flow is a no-op", () => {
    const once = normalizeFlow(realShape);
    const twice = normalizeFlow(once);
    expect(twice).toEqual(once);
  });
});
