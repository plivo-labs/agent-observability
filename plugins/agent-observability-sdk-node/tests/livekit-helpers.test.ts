import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initObservability, addGoalTags, ensureObservabilityUrl } from "../src/livekit/index.js";

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
      "agent_name:bot",
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

  // The `goals` option — conversation goals the server's analyzer judges
  // post-session. Wire format: `goal:<name>:<description>`, split
  // server-side at the FIRST colon after the prefix (names must not
  // contain colons; descriptions may).
  describe("goals", () => {
    const quiet = { info: () => {}, warn: () => {} };

    function initWithGoals(goals: Array<string | { name: string; description?: string }>) {
      process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
      const { tagger, calls } = makeTagger();
      initObservability(tagger, { agentId: "agent-uuid-1", goals, logger: quiet });
      return calls;
    }

    it("emits one goal tag per goal", () => {
      const calls = initWithGoals([
        { name: "identity-check", description: "Confirm the caller's identity" },
        { name: "order-resolution", description: "Resolve the order issue or open a ticket" },
      ]);
      const names = calls.map((c) => c.name);
      expect(names).toContain("goal:identity-check:Confirm the caller's identity");
      expect(names).toContain("goal:order-resolution:Resolve the order issue or open a ticket");
    });

    it("bare string goals emit the name-only form", () => {
      const names = initWithGoals(["identity-check"]).map((c) => c.name);
      expect(names).toContain("goal:identity-check");
    });

    it("empty description collapses to the name-only form", () => {
      const names = initWithGoals([{ name: "identity-check", description: "  " }]).map(
        (c) => c.name,
      );
      expect(names).toContain("goal:identity-check");
    });

    it("goal tag metadata carries name and description", () => {
      const calls = initWithGoals([{ name: "refund", description: "Issue a refund when asked" }]);
      const goalCall = calls.find((c) => c.name.startsWith("goal:"));
      expect(goalCall?.metadata).toEqual({
        name: "refund",
        description: "Issue a refund when asked",
      });
    });

    it("wrapper metadata includes goals", () => {
      const calls = initWithGoals([
        { name: "refund", description: "Issue a refund" },
        "identity-check",
      ]);
      expect(calls[0].name).toBe("agent.session");
      expect(calls[0].metadata?.goals).toEqual([
        { name: "refund", description: "Issue a refund" },
        { name: "identity-check" },
      ]);
    });

    it("trims name and description", () => {
      const names = initWithGoals([{ name: " refund ", description: "  Issue a refund  " }]).map(
        (c) => c.name,
      );
      expect(names).toContain("goal:refund:Issue a refund");
    });

    it("descriptions may contain colons", () => {
      const names = initWithGoals([
        { name: "escalation", description: "Escalate: only after two failures" },
      ]).map((c) => c.name);
      expect(names).toContain("goal:escalation:Escalate: only after two failures");
    });

    it("rejects a goal name containing a colon", () => {
      process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
      for (const bad of [{ name: "bad:name", description: "d" }, "bad:name"]) {
        expect(() =>
          initObservability(makeTagger().tagger, {
            agentId: "a1",
            goals: [bad],
            logger: quiet,
          }),
        ).toThrow(/colon/);
      }
    });

    it("rejects an empty goal name", () => {
      process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
      for (const bad of [{ name: "", description: "d" }, "   "]) {
        expect(() =>
          initObservability(makeTagger().tagger, {
            agentId: "a1",
            goals: [bad],
            logger: quiet,
          }),
        ).toThrow(/name/);
      }
    });

    it("rejects duplicate goal names", () => {
      process.env.LIVEKIT_OBSERVABILITY_URL = "https://obs.example.com";
      // Same name twice — even across object and bare-string forms, and
      // even when the descriptions differ (the server would silently keep
      // only the first, which is almost certainly a bug upstream).
      const dups: Array<Array<string | { name: string; description?: string }>> = [
        [
          { name: "refund", description: "v1 wording" },
          { name: "refund", description: "v2 wording" },
        ],
        [{ name: "refund", description: "described" }, "refund"],
      ];
      for (const goals of dups) {
        expect(() =>
          initObservability(makeTagger().tagger, { agentId: "a1", goals, logger: quiet }),
        ).toThrow(/duplicate/);
      }
    });
  });
});

// addGoalTags — the goals-only emitter for workers whose observability
// bootstrap happens elsewhere (agent-transport wires identity tags +
// upload internally).
describe("addGoalTags", () => {
  it("emits goal tags and returns the normalized goals, no URL env required", () => {
    delete process.env.LIVEKIT_OBSERVABILITY_URL;
    delete process.env.AGENT_OBSERVABILITY_URL;
    const { tagger, calls } = makeTagger();
    const returned = addGoalTags(tagger, [
      { name: "refund", description: "Issue a refund when asked" },
      "identity-check",
    ]);
    expect(calls.map((c) => c.name)).toEqual([
      "goal:refund:Issue a refund when asked",
      "goal:identity-check",
    ]);
    expect(returned).toEqual([
      { name: "refund", description: "Issue a refund when asked" },
      { name: "identity-check" },
    ]);
  });

  it("applies the same validation as initObservability", () => {
    expect(() => addGoalTags(makeTagger().tagger, ["bad:name"])).toThrow(/colon/);
    expect(() => addGoalTags(makeTagger().tagger, ["twice", "twice"])).toThrow(/duplicate/);
    expect(() => addGoalTags(makeTagger().tagger, ["   "])).toThrow(/name/);
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
