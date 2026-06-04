import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  priceFor,
  normalizeProvider,
  normalizeModel,
  reloadPrices,
  __setPricesForTesting,
  __resetPricingForTesting,
} from "../src/evals/pricing.js";

describe("normalizeProvider", () => {
  test("lowercases", () => {
    expect(normalizeProvider("OpenAI")).toBe("openai");
    expect(normalizeProvider("ANTHROPIC")).toBe("anthropic");
  });

  test("strips scheme, leading api., and TLDs", () => {
    expect(normalizeProvider("https://api.openai.com")).toBe("openai");
    expect(normalizeProvider("api.anthropic.ai")).toBe("anthropic");
    expect(normalizeProvider("@openai")).toBe("openai");
  });

  test("strips separators (dashes, underscores, spaces)", () => {
    expect(normalizeProvider("Open AI")).toBe("openai");
    expect(normalizeProvider("open-ai")).toBe("openai");
    expect(normalizeProvider("open_ai")).toBe("openai");
  });
});

describe("normalizeModel", () => {
  test("lowercases and strips dated suffixes", () => {
    expect(normalizeModel("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(normalizeModel("GPT-4o-2024-08-06")).toBe("gpt-4o");
    expect(normalizeModel("claude-sonnet-4-5-20241022")).toBe(
      "claude-sonnet-4-5",
    );
  });

  test("strips -latest suffix", () => {
    expect(normalizeModel("claude-sonnet-4-latest")).toBe("claude-sonnet-4");
  });

  test("passes through unmodified for plain model ids", () => {
    expect(normalizeModel("gpt-4o-mini")).toBe("gpt-4o-mini");
  });
});

describe("priceFor", () => {
  const SEED = {
    "openai:gpt-4o": { input: 2.5, output: 10, cache_read: 1.25 },
    "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    "anthropic:claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3 },
  };

  beforeEach(() => {
    __setPricesForTesting({ ...SEED });
  });

  afterEach(() => {
    __resetPricingForTesting();
  });

  test("returns the price for an exact match", () => {
    expect(priceFor("openai", "gpt-4o-mini")).toEqual({
      input: 0.15,
      output: 0.6,
    });
  });

  test("returns null when provider:model isn't in the table", () => {
    expect(priceFor("unknown", "x")).toBeNull();
    expect(priceFor("openai", "gpt-9000")).toBeNull();
  });

  test("returns null when provider or model is missing", () => {
    expect(priceFor(null, "gpt-4o-mini")).toBeNull();
    expect(priceFor("openai", null)).toBeNull();
    expect(priceFor(undefined, undefined)).toBeNull();
  });

  test("lookup is case-insensitive on provider and model", () => {
    expect(priceFor("OpenAI", "GPT-4O-mini")).toEqual({
      input: 0.15,
      output: 0.6,
    });
  });

  test("dated model-id suffixes get stripped before lookup", () => {
    expect(priceFor("openai", "gpt-4o-2024-08-06")?.input).toBe(2.5);
    expect(priceFor("anthropic", "claude-sonnet-4-5-20241022")?.input).toBe(3);
  });

  test("optional cache_read rate surfaces when set", () => {
    expect(priceFor("openai", "gpt-4o")?.cache_read).toBe(1.25);
    // gpt-4o-mini has no cache_read in this seed.
    expect(priceFor("openai", "gpt-4o-mini")?.cache_read).toBeUndefined();
  });
});

describe("reloadPrices (models.dev fetch)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    __resetPricingForTesting();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetPricingForTesting();
  });

  test("replaces the in-memory map with parsed models.dev payload", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": { cost: { input: 0.15, output: 0.6, cache_read: 0.075 } },
              "gpt-5": { cost: { input: 5, output: 20 } },
            },
          },
          anthropic: {
            models: {
              "claude-sonnet-4-7": { cost: { input: 3, output: 15 } },
            },
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    await reloadPrices();

    expect(priceFor("openai", "gpt-5")).toEqual({
      input: 5,
      output: 20,
      cache_read: undefined,
    });
    expect(priceFor("openai", "gpt-4o-mini")?.cache_read).toBe(0.075);
    expect(priceFor("anthropic", "claude-sonnet-4-7")?.input).toBe(3);
  });

  test("ignores models that have malformed cost objects", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o": { cost: { input: 2.5, output: 10 } },
              "bad-no-cost": {},
              "bad-string-cost": { cost: { input: "two-fifty", output: 10 } },
              "bad-missing-output": { cost: { input: 2 } },
            },
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    await reloadPrices();

    expect(priceFor("openai", "gpt-4o")).toBeDefined();
    expect(priceFor("openai", "bad-no-cost")).toBeNull();
    expect(priceFor("openai", "bad-string-cost")).toBeNull();
    expect(priceFor("openai", "bad-missing-output")).toBeNull();
  });

  test("fetch failure preserves the existing map (doesn't blow up)", async () => {
    // Seed something the fetch shouldn't be able to wipe.
    __setPricesForTesting({
      "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    });
    __resetPricingForTesting();
    __setPricesForTesting({
      "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    });

    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    // Should NOT throw — failure is silently logged and caller continues.
    await reloadPrices();

    // Existing seed remains intact.
    expect(priceFor("openai", "gpt-4o-mini")?.input).toBe(0.15);
  });

  test("non-2xx response preserves the existing map", async () => {
    __setPricesForTesting({
      "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    });

    globalThis.fetch = mock(async () =>
      new Response("Service Unavailable", { status: 503 }),
    ) as unknown as typeof globalThis.fetch;

    await reloadPrices();

    expect(priceFor("openai", "gpt-4o-mini")?.input).toBe(0.15);
  });

  test("empty parse result preserves the existing map", async () => {
    __setPricesForTesting({
      "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    });

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ openai: { models: {} } }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    await reloadPrices();

    expect(priceFor("openai", "gpt-4o-mini")?.input).toBe(0.15);
  });
});
