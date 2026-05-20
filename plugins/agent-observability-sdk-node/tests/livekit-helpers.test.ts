import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initObservability, ensureObservabilityUrl } from "../src/livekit/index.js";

interface RecordedTag {
  name: string;
  metadata?: Record<string, unknown>;
}

function makeTagger(): { tagger: { add: (name: string, opts?: { metadata?: Record<string, unknown> }) => void }; calls: RecordedTag[] } {
  const calls: RecordedTag[] = [];
  return {
    tagger: {
      add(name, opts) {
        calls.push({ name, metadata: opts?.metadata });
      },
    },
    calls,
  };
}

// All tests run with a clean env so cross-test bleed doesn't cause false
// passes. Snapshot the relevant keys, restore in `afterEach`.
const ENV_KEYS = [
  "LIVEKIT_OBSERVABILITY_URL",
  "AGENT_OBSERVABILITY_URL",
  "AGENT_OBSERVABILITY_AGENT_ID",
];

describe("initObservability", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("emits full bundle when all options supplied", () => {
    process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
    const { tagger, calls } = makeTagger();

    const resolved = initObservability(tagger, {
      agentId: "agent-uuid-1",
      agentName: "bot",
      accountId: "acct-7",
      transport: "text",
      logger: { info: () => {}, warn: () => {} },
    });

    expect(resolved).toBe("agent-uuid-1");
    expect(calls.map((c) => c.name)).toEqual([
      "agent.session",
      "agent_id:agent-uuid-1",
      "account_id:acct-7",
      "agent.name:bot",
      "transport:text",
    ]);
    expect(calls[0].metadata).toEqual({
      agent_id: "agent-uuid-1",
      agent_name: "bot",
      account_id: "acct-7",
      transport: "text",
    });
  });

  it("emits only agent_id when optional kwargs omitted", () => {
    process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
    const { tagger, calls } = makeTagger();

    initObservability(tagger, {
      agentId: "agent-uuid-2",
      logger: { info: () => {}, warn: () => {} },
    });

    expect(calls.map((c) => c.name)).toEqual(["agent.session", "agent_id:agent-uuid-2"]);
    expect(calls[0].metadata).toEqual({ agent_id: "agent-uuid-2" });
  });

  it("falls back to env when agentId omitted", () => {
    process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
    process.env.AGENT_OBSERVABILITY_AGENT_ID = "env-agent";
    const { tagger, calls } = makeTagger();

    const resolved = initObservability(tagger, {
      logger: { info: () => {}, warn: () => {} },
    });

    expect(resolved).toBe("env-agent");
    expect(calls.map((c) => c.name)).toContain("agent_id:env-agent");
  });

  it("throws when agentId is unresolvable", () => {
    process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
    const { tagger, calls } = makeTagger();

    expect(() =>
      initObservability(tagger, { logger: { info: () => {}, warn: () => {} } }),
    ).toThrow(/agentId is required/);
    expect(calls).toEqual([]);
  });

  it("throws when observability URL unset", () => {
    const { tagger, calls } = makeTagger();

    expect(() =>
      initObservability(tagger, {
        agentId: "a1",
        logger: { info: () => {}, warn: () => {} },
      }),
    ).toThrow(/no upload target/);
    expect(calls).toEqual([]);
  });

  it("URL check runs before agent_id check", () => {
    const { tagger } = makeTagger();
    expect(() =>
      initObservability(tagger, { logger: { info: () => {}, warn: () => {} } }),
    ).toThrow(/no upload target/);
  });

  it("argument wins over env", () => {
    process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
    process.env.AGENT_OBSERVABILITY_AGENT_ID = "env-loser";
    const { tagger, calls } = makeTagger();

    const resolved = initObservability(tagger, {
      agentId: "arg-winner",
      logger: { info: () => {}, warn: () => {} },
    });

    expect(resolved).toBe("arg-winner");
    expect(calls.map((c) => c.name)).toContain("agent_id:arg-winner");
    expect(calls.map((c) => c.name)).not.toContain("agent_id:env-loser");
  });

  it("extraMetadata rides on wrapper only", () => {
    process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
    const { tagger, calls } = makeTagger();

    initObservability(tagger, {
      agentId: "a1",
      extraMetadata: { deployment: "staging", region: "us-east-1" },
      logger: { info: () => {}, warn: () => {} },
    });

    expect(calls[0].metadata).toEqual({
      agent_id: "a1",
      deployment: "staging",
      region: "us-east-1",
    });
    expect(calls.map((c) => c.name)).toEqual(["agent.session", "agent_id:a1"]);
  });
});

describe("ensureObservabilityUrl", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("returns LIVEKIT_OBSERVABILITY_URL when set", () => {
    process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(ensureObservabilityUrl({ logger })).toBe("https://obs.example.com");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("falls back to AGENT_OBSERVABILITY_URL and mirrors", () => {
    process.env.AGENT_OBSERVABILITY_URL = "https://obs.example.com";
    const logger = { info: vi.fn(), warn: vi.fn() };
    const url = ensureObservabilityUrl({ logger });
    expect(url).toBe("https://obs.example.com");
    expect(process.env.LIVEKIT_OBSERVABILITY_URL).toBe("https://obs.example.com");
  });

  it("returns null and warns when neither var set", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(ensureObservabilityUrl({ logger })).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
