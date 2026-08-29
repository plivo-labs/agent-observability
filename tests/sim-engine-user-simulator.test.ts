import { describe, test, expect, mock } from "bun:test";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

// completeJSON reads config (model selection, timeout, retries) even when a provider is
// injected, so mock it exactly like the sim-gen tests do — no real env, no network.
mock.module("../src/config.js", () => ({
  ...TEST_CONFIG_MODULE_DEFAULTS,
  config: {
    LLM_PROVIDER: "anthropic",
    JUDGE_MODEL: undefined,
    SIMULATOR_MODEL: undefined,
    GENERATOR_MODEL: undefined,
    LLM_TIMEOUT_MS: 30000,
    LLM_MAX_RETRIES: 1,
  },
}));

const {
  buildUserSimulatorPrompt,
  expandTraitDirectives,
  generateUserMessage,
} = await import("../src/sim-engine/run-engine/user-simulator.js");
const { MockLLM } = await import("../src/llm/index.js");
import type { ConversationTurn } from "../src/sim-engine/run-engine/user-simulator.js";
import type { Scenario } from "../src/sim-engine/schema.js";

// A minimal scenario builder — only the fields the prompt reads must be present, but we
// supply a full Scenario so generateUserMessage's typed input is satisfied.
function scenario(
  over: Omit<Partial<Scenario>, "persona"> & { persona?: Partial<Scenario["persona"]> } = {},
): Scenario {
  const { persona: personaOver, ...rest } = over;
  const persona = {
    personality: "direct",
    emotional_state: "neutral",
    behavioral_traits: ["cooperative"],
    details: { caller_name: "Alex" },
    ...(personaOver ?? {}),
  };
  return {
    id: "sc-1",
    name: "Generic",
    goal: "Book an appointment",
    language: "",
    interruption: { enabled: false, probability: 0 },
    stt_noise: { enabled: false, severity: "light" },
    non_answer: { enabled: false, probability: 0 },
    world_state: {},
    start_node_params: {},
    max_turns: 25,
    tags: [],
    acceptance_criteria: [],
    criteria_threshold: 0.7,
    ...rest,
    persona,
  } as Scenario;
}

describe("buildUserSimulatorPrompt — pinned template structure & injection", () => {
  test("emits the key sections in the pinned order (contract before identity)", () => {
    const p = buildUserSimulatorPrompt(scenario(), [], "Refund helpline", false, "", "");

    // Section presence — the load-bearing headings of the verbatim template.
    expect(p).toContain("You are simulating a real customer on a phone call.");
    expect(p).toContain("WHAT COUNTS AS A COMPLETE RESPONSE");
    expect(p).toContain("LENGTH AND SHAPE (character profile, not per-turn budget)");
    expect(p).toContain("Hard ceiling: 20 words.");
    expect(p).toContain("HARD-FORBID (these break the simulation):");
    expect(p).toContain("Pop-culture / fictional references the agent didn't bring up.");
    expect(p).toContain("how can I help you"); // forbid-rule phrasing
    expect(p).toContain("Conversation so far:");
    expect(p).toContain("Generate your next response as the customer.");

    // Ordering: the length/shape contract must precede the identity line (Go test parity).
    expect(p.indexOf("LENGTH AND SHAPE")).toBeLessThan(p.indexOf("Your identity:"));
    expect(p.indexOf("LENGTH AND SHAPE")).toBeGreaterThan(-1);
  });

  test("injects persona / goal / agent-flow-description verbatim", () => {
    const p = buildUserSimulatorPrompt(
      scenario({
        goal: "Get a refund for my broken toaster",
        persona: {
          personality: "concise",
          emotional_state: "angry",
          behavioral_traits: ["cooperative"],
          details: { caller_name: "Riley" },
        },
      }),
      [],
      "Refund helpline",
      false,
      "",
      "",
    );
    expect(p).toContain("Service: Refund helpline");
    expect(p).toContain("Your identity: Riley");
    expect(p).toContain("Communication style: concise");
    expect(p).toContain("Emotional state guidance: angry");
    expect(p).toContain("Behavioral traits guidance: cooperative");
    expect(p).toContain("Private caller context:");
    expect(p).toContain("Get a refund for my broken toaster");
  });

  test("falls back to 'Customer' identity when no caller_name", () => {
    const p = buildUserSimulatorPrompt(
      scenario({ persona: { personality: "", emotional_state: "", behavioral_traits: [], details: {} } }),
      [],
      "",
      false,
      "",
      "",
    );
    expect(p).toContain("Your identity: Customer");
    // Empty comm-style / emotional-state lines are omitted (the {{- if}} guards).
    expect(p).not.toContain("Communication style:");
    expect(p).not.toContain("Emotional state guidance:");
  });

  test("injects conversation history as Customer:/Agent: lines", () => {
    const history: ConversationTurn[] = [
      { role: "assistant", content: "Hi, how can I help you today?" },
      { role: "user", content: "I need to check my order" },
    ];
    const p = buildUserSimulatorPrompt(scenario(), history, "", false, "", "");
    expect(p).toContain("Agent: Hi, how can I help you today?");
    expect(p).toContain("Customer: I need to check my order");
  });

  test("sorts and stringifies persona.details (Go %v: numbers bare, keys sorted)", () => {
    const p = buildUserSimulatorPrompt(
      scenario({ persona: { personality: "p", emotional_state: "e", behavioral_traits: [], details: { account_tier: "gold", age: 34, caller_name: "Priya" } } }),
      [],
      "",
      false,
      "",
      "",
    );
    const idxTier = p.indexOf("- account_tier: gold");
    const idxAge = p.indexOf("- age: 34");
    const idxName = p.indexOf("- caller_name: Priya");
    expect(idxTier).toBeGreaterThan(-1);
    expect(idxAge).toBeGreaterThan(-1);
    expect(idxName).toBeGreaterThan(-1);
    expect(idxTier).toBeLessThan(idxAge); // sorted: account_tier < age < caller_name
    expect(idxAge).toBeLessThan(idxName);
  });

  test("language: non-English adds 'Respond in', English/empty do not", () => {
    expect(buildUserSimulatorPrompt(scenario({ language: "Hindi" }), [], "", false, "", "")).toContain(
      "Language: Respond in Hindi.",
    );
    expect(buildUserSimulatorPrompt(scenario({ language: "English" }), [], "", false, "", "")).not.toContain(
      "Language: Respond in",
    );
    expect(buildUserSimulatorPrompt(scenario({ language: "" }), [], "", false, "", "")).not.toContain(
      "Language: Respond in",
    );
  });

  test("Hindi triggers Devanagari + Indian register; plain English does not", () => {
    const hi = buildUserSimulatorPrompt(scenario({ language: "Hindi" }), [], "", false, "", "");
    expect(hi).toContain("Devanagari script");
    expect(hi).toContain("Indian phone register:");

    const hinglish = buildUserSimulatorPrompt(scenario({ language: "Hinglish" }), [], "", false, "", "");
    expect(hinglish).toContain("Indian phone register:");
    expect(hinglish).not.toContain("Devanagari script"); // Hinglish ≠ Hindi script

    const en = buildUserSimulatorPrompt(scenario({ language: "English" }), [], "", false, "", "");
    expect(en).not.toContain("Indian phone register:");
  });

  test("interruption mode block only when a partial assistant message is given", () => {
    const history: ConversationTurn[] = [
      { role: "assistant", content: "Sure, let me look that up for you. I'll need your or--" },
    ];
    const on = buildUserSimulatorPrompt(scenario(), history, "Order tracking", false, "Sure, let me look that up for you. I'll need your or--", "");
    expect(on).toContain("INTERRUPTION MODE:");
    expect(on).toContain("I'll need your or--");
    expect(on).toContain("**Answer**");
    // STT block is suppressed inside interruption? No — interruption is NOT a non-answer, so
    // STT still renders. Non-answer is the suppressor (separate test).
    expect(on).toContain("STT SIMULATION");

    const off = buildUserSimulatorPrompt(scenario(), [], "Order tracking", false, "", "");
    expect(off).not.toContain("INTERRUPTION MODE:");
  });

  test("non-answer mode renders the right flavor and suppresses STT", () => {
    const presence = buildUserSimulatorPrompt(scenario(), [], "", false, "", "presence_check");
    expect(presence).toContain("NON-ANSWER MODE");
    expect(presence).toContain("brief presence check");
    expect(presence).not.toContain("STT SIMULATION"); // {{- if not .IsNonAnswer}} gate

    const topic = buildUserSimulatorPrompt(scenario(), [], "", false, "", "topic_lock");
    expect(topic).toContain("NON-ANSWER MODE");
    expect(topic).toContain("brief clarification request");
    expect(topic).not.toContain("STT SIMULATION");
  });

  test("STT severity: always-on light by default; explicit severity respected", () => {
    const def = buildUserSimulatorPrompt(scenario(), [], "", false, "", "");
    expect(def).toContain("STT SIMULATION");
    expect(def).toContain("Severity: light");

    const heavy = buildUserSimulatorPrompt(
      scenario({ stt_noise: { enabled: true, severity: "heavy" } }),
      [],
      "",
      false,
      "",
      "",
    );
    expect(heavy).toContain("Severity: heavy");
  });

  test("outbound vs inbound opener", () => {
    const out = buildUserSimulatorPrompt(scenario(), [], "", true, "", "");
    expect(out).toContain("You received this call");
    expect(out).not.toContain("You initiated this call.");

    const inb = buildUserSimulatorPrompt(scenario(), [], "", false, "", "");
    expect(inb).toContain("You initiated this call.");
    expect(inb).not.toContain("You received this call");
  });

  test("appends the TARGET DETECTION + END CALL decision block", () => {
    const p = buildUserSimulatorPrompt(scenario(), [], "Refund helpline", false, "", "");
    expect(p).toContain("TARGET DETECTION AND END CALL:");
    expect(p).toContain("target_achieved:");
    expect(p).toContain("end_call:");
    // The decision block sits at the very end, right before the final generate instruction.
    expect(p.indexOf("TARGET DETECTION AND END CALL:")).toBeGreaterThan(p.indexOf("Conversation so far:"));
    expect(p.indexOf("TARGET DETECTION AND END CALL:")).toBeLessThan(p.indexOf("Generate your next response as the customer."));
  });
});

describe("expandTraitDirectives — behavioral-trait mapping (behavioral_traits.go)", () => {
  test("known trait expands to its directive; appears alongside the raw verbatim line", () => {
    const p = buildUserSimulatorPrompt(
      scenario({ persona: { personality: "", emotional_state: "", behavioral_traits: ["digit_transposition"], details: {} } }),
      [],
      "",
      false,
      "",
      "",
    );
    expect(p).toContain("Behavioral traits guidance: digit_transposition"); // raw line preserved
    expect(p).toContain("adjacent digits"); // concrete directive
  });

  test("entity-capture trait appends the entity-discipline directive", () => {
    const directives = expandTraitDirectives(["name_spells_then_self_doubts"]);
    expect(directives.some((d) => d.includes("confirm, repeat, or spell"))).toBe(true);
  });

  test("non-capture trait does NOT append the entity-discipline directive", () => {
    const directives = expandTraitDirectives(["cooperative"]);
    expect(directives.some((d) => d.includes("confirm, repeat, or spell"))).toBe(false);
  });

  test("unknown trait yields no directive but the raw token survives in the verbatim line", () => {
    const directives = expandTraitDirectives(["asks_for_manager_immediately", "rushes"]);
    // No fabricated directive for the unknown token.
    expect(directives.some((d) => d.includes("asks_for_manager_immediately"))).toBe(false);
    // Known trait still expands.
    expect(directives.some((d) => /hurry|skip/i.test(d))).toBe(true);

    // And the raw token rides along in the prompt's verbatim guidance line.
    const p = buildUserSimulatorPrompt(
      scenario({ persona: { personality: "", emotional_state: "", behavioral_traits: ["cooperative", "asks_for_manager_immediately"], details: {} } }),
      [],
      "",
      false,
      "",
      "",
    );
    expect(p).toContain("Behavioral traits guidance: cooperative; asks_for_manager_immediately");
  });

  test("preserves order and appends entity directive exactly once", () => {
    const directives = expandTraitDirectives(["digit_transposition", "digit_chunk_dribble"]);
    const entityHits = directives.filter((d) => d.includes("confirm, repeat, or spell")).length;
    expect(entityHits).toBe(1); // appended once even with two capture traits
    expect(directives[directives.length - 1]).toContain("confirm, repeat, or spell"); // appended last
  });
});

describe("generateUserMessage — LLM call (MockLLM injected)", () => {
  test("returns the parsed message from a single structured call", async () => {
    const provider = new MockLLM([JSON.stringify({ message: "Yes, please." })]);
    const msg = await generateUserMessage({
      scenario: scenario(),
      history: [],
      agentFlowDescription: "Refund helpline",
      isOutboundCall: false,
      partialAssistantMsg: "",
      nonAnswerType: "",
      provider,
    });
    expect(msg.message).toBe("Yes, please.");
    // A bare {message} mock still parses — target_achieved / end_call default to false.
    expect(msg.target_achieved).toBe(false);
    expect(msg.end_call).toBe(false);
    // The provider saw exactly one call, carrying our pinned prompt content. The
    // simulator sends the template as `system` with an empty `user` (cx-sqs parity:
    // apiMode "chat" + noJsonHint), so assert on `system`.
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].system).toContain("You are simulating a real customer");
    expect(provider.calls[0].system).toContain("Service: Refund helpline");
  });

  test("retries once on an empty message, then succeeds", async () => {
    // Queue length > 1 → first call shifts the empty responder, second reuses the last.
    const provider = new MockLLM([JSON.stringify({ message: "   " }), JSON.stringify({ message: "Okay." })]);
    const msg = await generateUserMessage({
      scenario: scenario(),
      history: [],
      agentFlowDescription: "",
      isOutboundCall: false,
      partialAssistantMsg: "",
      nonAnswerType: "",
      provider,
    });
    expect(msg.message).toBe("Okay.");
    expect(provider.calls.length).toBe(2); // one retry after the blank
  });

  test("parses the caller-decision fields when the model returns them", async () => {
    const provider = new MockLLM([JSON.stringify({ message: "Okay, thanks. Bye.", target_achieved: true, end_call: true })]);
    const msg = await generateUserMessage({
      scenario: scenario(),
      history: [],
      agentFlowDescription: "",
      isOutboundCall: false,
      partialAssistantMsg: "",
      nonAnswerType: "",
      provider,
    });
    expect(msg).toEqual({ message: "Okay, thanks. Bye.", target_achieved: true, end_call: true });
  });

  test("throws when the message is still empty after the retry", async () => {
    const provider = new MockLLM([JSON.stringify({ message: "" })]);
    await expect(
      generateUserMessage({
        scenario: scenario(),
        history: [],
        agentFlowDescription: "",
        isOutboundCall: false,
        partialAssistantMsg: "",
        nonAnswerType: "",
        provider,
      }),
    ).rejects.toThrow(/empty message after retry/);
  });
});

describe("generateUserMessage — reasoning effort (the per-turn dial)", () => {
  const base = {
    scenario: scenario(),
    history: [] as ConversationTurn[],
    agentFlowDescription: "Refund helpline",
    isOutboundCall: false,
    partialAssistantMsg: "",
    nonAnswerType: "",
  };

  test("forwards the configured effort on the pinned chat transport", async () => {
    // This role is billed and timed per simulated TURN, so its effort multiplies across a
    // conversation — unlike the generation dials, which apply once per request.
    const provider = new MockLLM([JSON.stringify({ message: "Yes, please." })]);
    await generateUserMessage({ ...base, provider, reasoningEffort: "none" });
    expect(provider.calls[0].reasoningEffort).toBe("none");
    // apiMode must stay pinned: the effort only reaches the wire because the Chat
    // Completions path now forwards it as a flat `reasoning_effort`.
    expect(provider.calls[0].apiMode).toBe("chat");
  });

  test("omits the parameter when unset, preserving the pre-existing wire shape", async () => {
    const provider = new MockLLM([JSON.stringify({ message: "Sure." })]);
    await generateUserMessage({ ...base, provider });
    expect(provider.calls[0].reasoningEffort).toBeUndefined();
    expect(provider.calls[0].apiMode).toBe("chat");
  });

  test("still sends no output cap — effort must not reintroduce max_tokens", async () => {
    // The uncapped call is what keeps `max_tokens` (which gpt-5.x rejects on
    // chat/completions) out of the body. Pairing an explicit effort with a cap here
    // would 400 every turn.
    const provider = new MockLLM([JSON.stringify({ message: "Ok." })]);
    await generateUserMessage({ ...base, provider, reasoningEffort: "low" });
    expect(provider.calls[0].maxTokens).toBe(0);
  });
});
