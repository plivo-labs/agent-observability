import { describe, test, expect } from "bun:test";

import {
  buildSessionEvalInput,
  type AgentConfig,
} from "../src/evals-engine/integration/session-evals.js";

// Unit tests for the ingest→engine input builder. Pure logic (no LLM): verifies
// node grouping by opaque node_ref, tool/KB evidence rendering, variable-rule
// forwarding, the single-node fallback, and that verdict-order tracks input order.

function cfg(): AgentConfig {
  return {
    flow_name: "Support",
    global_prompt: "Be helpful.",
    goals: [{ name: "Resolved", instructions: "Issue resolved" }, { name: "", instructions: "dropped" }],
    nodes: [
      {
        ref: "node-A",
        name: "Greeter",
        instructions: "Greet and collect the name.",
        intents: [{ name: "Done", description: "finished" }],
        variables: [{ name: "caller_name", rule: "as stated" }, { name: "callback" }],
      },
      { ref: "node-B", name: "Closer", instructions: "Wrap up." },
    ],
  };
}

function ev(node_ref: string | undefined, role: string, text: string) {
  return { type: "conversation_item_added", node_ref, item: { type: "message", role, content: text } };
}

describe("buildSessionEvalInput", () => {
  test("groups turns by node_ref and maps config, in order", () => {
    const { input, nodeRefs } = buildSessionEvalInput(cfg(), [
      ev("node-A", "assistant", "Hi, your name?"),
      ev("node-A", "user", "Alex"),
      ev("node-B", "assistant", "Thanks, bye"),
    ]);
    expect(input.flow_name).toBe("Support");
    expect(input.global_prompt).toBe("Be helpful.");
    expect(input.nodes.map((n) => n.node_uuid)).toEqual(["node-A", "node-B"]);
    expect(nodeRefs.map((r) => r.ref)).toEqual(["node-A", "node-B"]);

    const a = input.nodes[0];
    expect(a.node_name).toBe("Greeter");
    expect(a.node_prompt).toBe("Greet and collect the name.");
    expect(a.required_variables).toEqual(["caller_name", "callback"]);
    expect(a.variable_rules).toEqual({ caller_name: "as stated" }); // rule-less var omitted
    expect(a.turn_count).toBe(2);
  });

  test("renders tool call + result as labelled evidence lines (not dropped)", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "user", "How much did I spend?"),
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "spend", arguments: { year: 2026 } } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call_output", name: "spend", output: { total: "$1,234" } } },
      ev("node-A", "assistant", "You spent $1,234."),
    ]);
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns).toContain('Tool_Call: spend({"year":2026})');
    expect(agentTurns).toContain('Tool_Result: spend -> {"total":"$1,234"}');
    expect(input.nodes[0].turn_count).toBe(4);
  });

  test("node transcript never renders an evidence line as agent speech", async () => {
    const { renderNodeTranscript } = await import("../src/evals-engine/judges/node-judge-payload.js");
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "user", "How much did I spend?"),
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "spend", arguments: { year: 2026 } } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call_output", name: "spend", output: { total: "$1,234" } } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "agent_handoff", name: "billing" } },
      ev("node-A", "assistant", "You spent $1,234."),
    ]);
    const t = renderNodeTranscript(input.nodes[0]);

    // Every judge prompt describes these as "lines labelled Tool_Call:/Tool_Result:/
    // System_Note:/Agent_Handoff:" — none mentions an "Agent: " prefix. Prefixing them
    // makes a runtime event indistinguishable from words the agent spoke to the caller,
    // which is what let the hallucination judge charge record_* arguments as fabricated
    // speech. Evidence lines carry their own label; they must render bare.
    expect(t).not.toContain("Agent: Tool_Call:");
    expect(t).not.toContain("Agent: Tool_Result:");
    expect(t).not.toContain("Agent: Agent_Handoff");

    // …and they must still be PRESENT: they are grounding evidence for the
    // hallucination judge and chosen-intent evidence for the intent judge.
    expect(t).toContain('Tool_Call: spend({"year":2026})');
    expect(t).toContain('Tool_Result: spend -> {"total":"$1,234"}');
    expect(t).toContain("Agent_Handoff: billing");

    // Real agent speech keeps its prefix.
    expect(t).toContain("Agent: You spent $1,234.");
    expect(t).toContain("User: How much did I spend?");

    // The SAME rule must hold for full_transcript: it reaches every node judge as
    // `conversation_history` (node-judges.ts nodePayload), so leaving the prefix here
    // would re-introduce the bug on the field the judge cross-checks against.
    expect(input.full_transcript).not.toContain("Agent: Tool_Call:");
    expect(input.full_transcript).not.toContain("Agent: Tool_Result:");
    expect(input.full_transcript).toContain('Tool_Call: spend({"year":2026})');
    expect(input.full_transcript).toContain("Agent: You spent $1,234.");
  });

  test("fills extracted_variables from the variable's declared recording tool", () => {
    const config: AgentConfig = {
      nodes: [{
        ref: "node-A",
        name: "Booking",
        variables: [
          { name: "patient_name", rule: "as stated", tool: "record_patient_name" },
          { name: "visit_type", tool: "record_visit_type" },
          { name: "missing_one", tool: "record_missing_one" },
        ],
      }],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "I am Alex, here for a cleaning"),
      // string-serialized arguments (how Python workers send them)
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "record_patient_name", arguments: '{"value": "Alex"}' } },
      // object arguments with multiple keys → kept whole
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "record_visit_type", arguments: { value: "cleaning", source: "user" } } },
      // unrelated tool never counts as an extraction
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "check_availability", arguments: { day: "Tue" } } },
    ]);
    expect(input.nodes[0].extracted_variables).toEqual({
      patient_name: "Alex",
      visit_type: { value: "cleaning", source: "user" },
    });
    // string args render parsed (not double-encoded) in the evidence line
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns).toContain('Tool_Call: record_patient_name({"value":"Alex"})');
  });

  test("derives chosen_intent from the intent's declared tool; handoffs render as evidence", () => {
    const config: AgentConfig = {
      nodes: [{
        ref: "node-A",
        name: "Booking",
        intents: [
          { name: "Booked", description: "confirmed", tool: "handoff_booked" },
          { name: "Declined", description: "caller declines", tool: "handoff_declined" },
        ],
      }],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "yes book it"),
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "handoff_booked", arguments: "{}" } },
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "agent_handoff", name: "closing-agent" } },
    ]);
    expect(input.nodes[0].chosen_intent).toBe("Booked");
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns).toContain("Agent_Handoff: closing-agent");
  });

  test("system-role messages render as truncated System_Note lines, not agent speech", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "system", content: "x".repeat(700) } },
      ev("node-A", "assistant", "Hi!"),
    ]);
    const agentTurns = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agentTurns[0]!.startsWith("System_Note: ")).toBe(true);
    expect(agentTurns[0]!.length).toBeLessThanOrEqual("System_Note: ".length + 601);
    expect(agentTurns[1]).toBe("Hi!");
  });

  test("speech_transcript drops evidence lines; variables credit cross-node recording calls", () => {
    const config: AgentConfig = {
      nodes: [
        { ref: "visit-1", name: "Booking", variables: [{ name: "patient_name", tool: "record_patient_name" }] },
        { ref: "visit-2", name: "Booking", variables: [{ name: "patient_name", tool: "record_patient_name" }] },
      ],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("visit-1", "user", "I am Alex"),
      { type: "conversation_item_added", node_ref: "visit-1", item: { type: "function_call", name: "record_patient_name", arguments: '{"value": "Alex"}' } },
      { type: "conversation_item_added", node_ref: "visit-2", item: { type: "message", role: "system", content: "internal steering note" } },
      ev("visit-2", "user", "back again"),
    ]);
    // Revisit (visit-2) credits the variable recorded during visit-1 —
    // re-recording is not required, so it must not read as missing.
    expect(input.nodes[1].extracted_variables).toEqual({ patient_name: "Alex" });
    // Speech-only transcript excludes Tool_Call + System_Note lines but the
    // full transcript keeps them.
    expect(input.full_transcript).toContain("Tool_Call: record_patient_name");
    expect(input.full_transcript).toContain("System_Note:");
    expect(input.speech_transcript).not.toContain("Tool_Call:");
    expect(input.speech_transcript).not.toContain("System_Note:");
    expect(input.speech_transcript).toContain("User: I am Alex");
  });

  test("full transcript stays chronological across node revisits", () => {
    const config: AgentConfig = {
      nodes: [{ ref: "node-A", name: "A" }, { ref: "node-B", name: "B" }],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "first"),
      ev("node-B", "user", "second"),
      ev("node-A", "user", "third"),
    ]);
    const order = input.full_transcript.split("\n").filter((l) => l.startsWith("User:"));
    expect(order).toEqual(["User: first", "User: second", "User: third"]);
  });

  test("falls back to the first node when the transcript carries no node_ref", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev(undefined, "assistant", "Hello"),
      ev(undefined, "user", "Hi"),
    ]);
    expect(input.nodes).toHaveLength(1);
    expect(input.nodes[0].node_uuid).toBe("node-A");
    expect(input.nodes[0].turn_count).toBe(2);
  });

  test("drops nameless goals; keeps valid ones", () => {
    const { input } = buildSessionEvalInput(cfg(), [ev("node-A", "user", "hi")]);
    expect(input.goals).toEqual([{ goal_name: "Resolved", goal_instructions: "Issue resolved", flow_goal_id: 0 }]);
  });

  test("nodes with no turns are excluded; empty inputs never throw", () => {
    // node-B configured but never spoken → excluded
    const { input } = buildSessionEvalInput(cfg(), [ev("node-A", "user", "hi")]);
    expect(input.nodes.map((n) => n.node_uuid)).toEqual(["node-A"]);
    expect(buildSessionEvalInput({}, []).input.nodes).toEqual([]);
    expect(buildSessionEvalInput({ nodes: [] }, []).input.nodes).toEqual([]);
  });

  test("renders full transcript in chronological order", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "assistant", "Q?"),
      ev("node-A", "user", "A"),
    ]);
    expect(input.full_transcript).toBe(["Agent: Q?", "User: A"].join("\n"));
  });

  test("tags agent turns matching config idle_messages as [system idle prompt]", () => {
    const config: AgentConfig = {
      ...cfg(),
      // Punctuation/case/whitespace drift between config and TTS transcript
      // must not break the match.
      idle_messages: [
        "Are you still there? I'm happy to assist whenever you're ready.",
        "Since I'm not hearing a response, I'll go ahead and disconnect",
      ],
    };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "hello"),
      ev("node-A", "assistant", "are you still there?  I'm happy to assist whenever you're ready"),
      ev("node-A", "assistant", "Are you still there? I'm happy to assist whenever you're ready."),
      // ASR often inserts a space before terminal punctuation — must still match.
      ev("node-A", "assistant", "Are you still there ? I'm happy to assist whenever you're ready ."),
      ev("node-A", "assistant", "Since I'm not hearing a response, I'll go ahead and disconnect."),
      ev("node-A", "assistant", "Your balance is due."),
    ]);
    const agents = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agents[0]).toContain("[system idle prompt]");
    expect(agents[1]).toContain("[system idle prompt]");
    expect(agents[2]).toContain("[system idle prompt]");
    expect(agents[3]).toContain("[system idle prompt]");
    expect(agents[4]).toBe("Your balance is due."); // real speech untouched
  });

  test("idle_messages text match never tags user turns; malformed idle_messages never throws", () => {
    const config: AgentConfig = { ...cfg(), idle_messages: ["Are you still there?"] };
    const { input } = buildSessionEvalInput(config, [
      ev("node-A", "user", "Are you still there?"), // user echoing the line stays untagged
      ev("node-A", "assistant", "Are you still there?"),
    ]);
    expect(input.nodes[0].turns[0].user).toBe("Are you still there?");
    expect(input.nodes[0].turns[1].agent).toContain("[system idle prompt]");
    // Garbage shapes are ignored, not fatal — AND produce no tagging: a bare
    // string ("reminder") is not a list, and pure-punctuation entries normalize
    // to "" which must not match punctuation-only agent turns.
    for (const bad of [42, "reminder", { msg: "x" }, [null, 7, "", "..."]]) {
      const { input: built } = buildSessionEvalInput(
        // Deliberately violates the declared string[] type: the ingest contract
        // is read defensively and must ignore garbage without throwing.
        { ...cfg(), idle_messages: bad as unknown as string[] },
        [ev("node-A", "assistant", "reminder"), ev("node-A", "assistant", "?!")],
      );
      for (const t of built.nodes[0].turns) expect(t.agent).not.toContain("[system idle prompt]");
    }
  });

  test("per-item system_idle flag still tags without config idle_messages", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "message", role: "assistant", content: "Still there?", system_idle: true } },
    ]);
    expect(input.nodes[0].turns[0].agent).toBe("Still there? [system idle prompt]");
  });

  test("auto-detects idle re-prompts: identical agent line repeated with no user speech between", () => {
    // No idle_messages config, no per-item flags — pure repeat detection.
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "assistant", "What's your order id?"),
      ev("node-A", "user", "hang on"),
      ev("node-A", "assistant", "Are you still there? I'm happy to assist whenever you're ready."),
      ev("node-A", "assistant", "Are you still there? I'm happy to assist whenever you're ready."),
      ev("node-A", "assistant", "Are you still there? I'm happy to assist whenever you're ready."),
      ev("node-A", "assistant", "Since I'm not hearing a response, I'll go ahead and disconnect."),
    ]);
    const agents = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agents[0]).toBe("What's your order id?");
    expect(agents[1]).toContain("[system idle prompt]"); // retro-tagged once the repeat proves it's scripted
    expect(agents[2]).toContain("[system idle prompt]"); // repeat into silence
    expect(agents[3]).toContain("[system idle prompt]");
    // The disconnect line follows the exhausted re-prompts with no user speech —
    // it's the configured idle-hangup message, tagged as part of the idle run.
    expect(agents[4]).toContain("[system idle prompt]");
  });

  test("idle-hangup tagging ends the run: a line after user speech is never tagged", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "assistant", "Are you still there?"),
      ev("node-A", "assistant", "Are you still there?"),
      ev("node-A", "user", "yes sorry, I'm here"),
      ev("node-A", "assistant", "Great — what's your order id?"),
    ]);
    const agents = input.nodes[0].turns.map((t) => t.agent).filter(Boolean);
    expect(agents[0]).toContain("[system idle prompt]");
    expect(agents[1]).toContain("[system idle prompt]");
    expect(agents[2]).toBe("Great — what's your order id?"); // user spoke → run over
  });

  test("loop judge conversation_history strips idle lines (memoized per session)", async () => {
    const { runLoopJudge } = await import("../src/evals-engine/judges/node-judges.js");
    const { MockLLM } = await import("../src/llm/index.js");
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "user", "hello"),
      ev("node-A", "assistant", "How can I help?"),
      ev("node-A", "assistant", "Are you still there?"),
      ev("node-A", "assistant", "Are you still there?"),
    ]);
    let seenHistory = "";
    const llm = new MockLLM([
      (args: { user?: string }) => {
        seenHistory = args.user ?? "";
        return JSON.stringify({ loop_detected: false, score: 1, reason: "r", technical_reason: "t" });
      },
    ]);
    await runLoopJudge(input.nodes[0], input, llm);
    expect(seenHistory).toContain("How can I help?");
    expect(seenHistory).not.toContain("Are you still there?"); // stripped from node transcript AND conversation history
  });

  test("repeat detection resets on user speech and ignores tool/system events", () => {
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "assistant", "Could you share the date?"),
      ev("node-A", "user", "sorry, what?"),
      // Same line again but the user spoke between → justified re-ask, NOT idle.
      ev("node-A", "assistant", "Could you share the date?"),
      // Tool + system events between repeats do not count as user speech.
      { type: "conversation_item_added", node_ref: "node-A", item: { type: "function_call", name: "noop", arguments: "{}" } },
      ev("node-A", "assistant", "Could you share the date?"),
    ]);
    const agents = input.nodes[0].turns.map((t) => t.agent).filter((a) => a && !a.startsWith("Tool_Call"));
    expect(agents[0]).not.toContain("[system idle prompt]"); // original ask before user spoke — never tagged
    // The re-ask (agents[1]) is retro-tagged once agents[2] repeats it with no
    // user speech between; the trailing repeat is tagged directly.
    expect(agents[1]).toContain("[system idle prompt]");
    expect(agents[2]).toContain("[system idle prompt]");
  });

  test("loop judge input drops idle-flagged turns entirely", async () => {
    const { withoutIdleTurns } = await import("../src/evals-engine/judges/node-judges.js");
    const { input } = buildSessionEvalInput(cfg(), [
      ev("node-A", "user", "hello"),
      ev("node-A", "assistant", "How can I help?"),
      ev("node-A", "assistant", "Are you still there?"),
      ev("node-A", "assistant", "Are you still there?"),
    ]);
    // Idle turns carry the structured flag; filtering keys on it, not on text.
    expect(input.nodes[0].turns.filter((t) => t.idle)).toHaveLength(2);
    const filtered = withoutIdleTurns(input.nodes[0]);
    const agents = filtered.turns.map((t) => t.agent).filter(Boolean);
    expect(agents).toEqual(["How can I help?"]); // both idle repeats (incl. retro-tagged first) removed
    expect(filtered.turn_count).toBe(2); // user turn + one agent turn

    // A user turn merely CONTAINING the tag text is never dropped (flag-based,
    // not substring-based).
    const echo = buildSessionEvalInput(cfg(), [ev("node-A", "user", "you said [system idle prompt] to me")]);
    expect(withoutIdleTurns(echo.input.nodes[0]).turn_count).toBe(1);
  });

  test("idle repeat cap: a stuck agent repeating past the cap stays visible to the loop judge", async () => {
    const { withoutIdleTurns } = await import("../src/evals-engine/judges/node-judges.js");
    // 6 identical substantive lines into dead air — a real loop, not idle
    // scaffolding (platform idle retries are <=3). Repeats past the cap must
    // stay untagged so the loop judge can still fire.
    const { input } = buildSessionEvalInput(cfg(), Array.from({ length: 6 }, () =>
      ev("node-A", "assistant", "Please provide your booking reference now."),
    ));
    const visible = withoutIdleTurns(input.nodes[0]);
    expect(visible.turn_count).toBeGreaterThanOrEqual(2); // enough repetition survives to detect a loop
  });

  test("repeat detection does not cross node boundaries", () => {
    // The same opening line spoken by two different node visits is each node's
    // own speech, not an idle re-prompt (idle timers re-speak within a node).
    const config: AgentConfig = { nodes: [{ ref: "visit-1", name: "A" }, { ref: "visit-2", name: "A" }] };
    const { input } = buildSessionEvalInput(config, [
      ev("visit-1", "assistant", "Hello, welcome to the clinic."),
      ev("visit-2", "assistant", "Hello, welcome to the clinic."),
    ]);
    for (const n of input.nodes) for (const t of n.turns) expect(t.idle).toBeUndefined();
  });
});

// ── session tags reach the conversation judges ──────────────────────────────
// The sweeper loads a session's tags (ao_session_tags) and hands them to the
// engine; the transfer axis is decided from them. Without a tag feed the axis
// must be undecidable, never a clean "no transfer".
describe("evaluateIngestedSession — session tags", () => {
  const judgeResponder = (consentGiven: boolean) => (args: { system?: string }) => {
    const s = args.system ?? "";
    if (s.includes("consent to the transfer"))
      return JSON.stringify({ consent_given: consentGiven, reason_code: consentGiven ? "ok" : "declined", reason: "r", technical_reason: "t" });
    if (s.includes("fabricated information")) return JSON.stringify({ hallucinated: false, score: 1, reason: "", technical_reason: "" });
    if (s.includes("Variables expected to be extracted")) return JSON.stringify({ extraction_successful: true, score: 1, reason: "", technical_reason: "", missing_variables: [], incorrect_variables: [] });
    if (s.includes("repeat its own previous messages")) return JSON.stringify({ loop_detected: false, score: 1, reason: "", technical_reason: "" });
    if (s.includes("correct intent for the conversation segment")) return JSON.stringify({ intent_not_found: false, intent_wrongly_identified: false, reason: "", technical_reason: "" });
    if (s.includes("four-part rubric"))
      return JSON.stringify({
        objective_progress: { achieved: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
        procedure_compliance: { score: 1, missed_steps: [], reason_code: "", reason: "", technical_reason: "" },
        interaction_quality: { score: 1, issues: [], reason_code: "", reason: "", technical_reason: "" },
        policy_boundary_compliance: { passed: true, score: 1, reason_code: "", reason: "", technical_reason: "" },
      });
    if (s.includes("configured goals were achieved")) return JSON.stringify({ goals: [{ goal_name: "Resolved", achieved: true, reason: "", technical_reason: "" }] });
    if (s.includes("Classify the user's sentiment")) return JSON.stringify({ sentiment: "neutral", reason: "r", technical_reason: "t" });
    if (s.includes("speech-to-text quality")) return JSON.stringify({ error_count: 0, recovered_count: 0, reason: "r", technical_reason: "t" });
    return JSON.stringify({ detected: false, reason: "r", technical_reason: "t" });
  };
  const events = () => [
    ev("node-A", "assistant", "Hi, can I connect you to a mover now?"),
    ev("node-A", "user", "no, not now"),
  ];

  test("a transfer:human tag reaches the transfer axis (fact fires, consent judged)", async () => {
    const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
    const { MockLLM } = await import("../src/llm/index.js");
    const llm = new MockLLM([judgeResponder(false)]);
    const verdicts = await evaluateIngestedSession(cfg(), events(), llm, "livekit", undefined, [
      { name: "transfer:human", metadata: { intent: "Transfer Approved" } },
    ]);
    expect(verdicts.conversation_metrics.human_transfer.available).toBe(true);
    expect(verdicts.conversation_metrics.human_transfer.detected).toBe(true);
    expect(verdicts.conversation_metrics.transfer_consent.detected).toBe(true);
    expect(verdicts.conversation_metrics.transfer_consent.reason_code).toBe("declined");
  });

  test("an empty transcript still yields the transfer FACT (it needs no transcript) with consent unavailable", async () => {
    const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
    const { MockLLM } = await import("../src/llm/index.js");
    const llm = new MockLLM([judgeResponder(true)]);
    // No conversation items at all → full_transcript is empty → the LLM axis is skipped.
    const verdicts = await evaluateIngestedSession(cfg(), [], llm, "livekit", undefined, [
      { name: "transfer:human", metadata: { intent: "Transfer Approved" } },
    ]);
    expect(verdicts.conversation_metrics.human_transfer.available).toBe(true);
    expect(verdicts.conversation_metrics.human_transfer.detected).toBe(true);
    // Nobody spoke and nothing was judged: consent is not fabricated.
    expect(verdicts.conversation_metrics.transfer_consent.available).toBe(false);
    expect(llm.calls.length).toBe(0);
  });

  test("no tag feed ⇒ the transfer axis is unavailable (undecidable)", async () => {
    const { evaluateIngestedSession } = await import("../src/evals-engine/integration/session-evals.js");
    const { MockLLM } = await import("../src/llm/index.js");
    const llm = new MockLLM([judgeResponder(true)]);
    const verdicts = await evaluateIngestedSession(cfg(), events(), llm, "livekit");
    expect(verdicts.conversation_metrics.human_transfer.available).toBe(false);
    expect(verdicts.conversation_metrics.transfer_consent.available).toBe(false);
  });
});
