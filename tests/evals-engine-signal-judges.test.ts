import { describe, expect, test } from "bun:test";
import {
  evaluateDeadAir,
  evaluateLatencyUx,
  evaluateAgentScriptSwitch,
  DEAD_AIR_RESPONSE_MS,
  DEAD_AIR_EVENT_COUNT,
  LATENCY_P95_MS,
  INTERRUPTION_RATE,
  INTERRUPTION_MIN_AGENT_TURNS,
} from "../src/evals-engine/judges/session-signal-judges.js";

// The code-derived signal judges. The single most important property under test
// is the AVAILABILITY CONTRACT: fanOutExternalEvals skips `available:false` and
// writes `available:true, detected:false` as a PASS. So "we had no data" must
// never come back as `detected:false` — that would manufacture a clean verdict
// out of missing measurements.

const metricsWith = (over: Record<string, unknown>) =>
  ({
    turns: [],
    tool_calls: [],
    summary: { total_turns: 0, ...over },
  }) as any;

const deadAirBlock = (over: Record<string, unknown> = {}) => ({
  threshold_ms: 3000,
  count: 0,
  total_ms: 0,
  max_ms: 0,
  events: [],
  ...over,
});

describe("evaluateDeadAir", () => {
  test("is UNAVAILABLE — not clean — when the session carries no timings", () => {
    for (const input of [null, metricsWith({}), metricsWith({ voice: {} })]) {
      const r = evaluateDeadAir(input);
      expect(r.available).toBe(false);
      expect(r.detected).toBe(false);
      expect(r.technical_reason).toContain("undecidable");
    }
  });

  test("fires on one silence at or over the single-gap threshold", () => {
    const r = evaluateDeadAir(
      metricsWith({
        voice: {
          dead_air: deadAirBlock({
            count: 1,
            max_ms: DEAD_AIR_RESPONSE_MS,
            total_ms: DEAD_AIR_RESPONSE_MS,
            events: [{ turn_number: 4, kind: "response", gap_ms: DEAD_AIR_RESPONSE_MS }],
          }),
        },
      }),
    );
    expect(r.detected).toBe(true);
    expect(r.available).toBe(true);
    // Names the turn, and attributes the wait to the AGENT — only response gaps
    // are scored, so the sentence can say who was responsible.
    expect(r.reason).toContain("turn 4");
    expect(r.reason).toContain("The agent left the caller waiting");
    expect(r.technical_reason).toContain("RESPONSE gap");
    expect(r.technical_reason).toStartWith("derived in code:");
  });

  test("fires on repeated shorter RESPONSE stalls via the count rule", () => {
    const events = Array.from({ length: DEAD_AIR_EVENT_COUNT }, (_, i) => ({
      turn_number: i + 1,
      kind: "response" as const,
      gap_ms: 3200,
    }));
    const r = evaluateDeadAir(
      metricsWith({
        voice: { dead_air: deadAirBlock({ count: events.length, max_ms: 3200, total_ms: 9600, events }) },
      }),
    );
    expect(r.detected).toBe(true);
    expect(r.reason).toContain(`${DEAD_AIR_EVENT_COUNT} times`);
  });

  test("stays clean below both rules — a single ordinary phone pause is not a defect", () => {
    const r = evaluateDeadAir(
      metricsWith({
        voice: {
          dead_air: deadAirBlock({
            count: 1,
            max_ms: 3500,
            total_ms: 3500,
            events: [{ turn_number: 2, kind: "response", gap_ms: 3500 }],
          }),
        },
      }),
    );
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);
  });

  // ── the response/inter_turn split ────────────────────────────────────────
  // `inter_turn` = agent stopped, caller had not yet started = the CALLER
  // thinking. Firing on it would blame the agent for the other party's pause.
  test("IGNORES inter_turn gaps entirely, however long", () => {
    const r = evaluateDeadAir(
      metricsWith({
        voice: {
          dead_air: deadAirBlock({
            count: 1,
            max_ms: 30000,
            total_ms: 30000,
            events: [{ turn_number: 2, kind: "inter_turn", gap_ms: 30000 }],
          }),
        },
      }),
    );
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);
    expect(r.technical_reason).toContain("caller think-time");
  });

  test("many inter_turn gaps do not satisfy the count rule", () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      turn_number: i + 1, kind: "inter_turn" as const, gap_ms: 4000,
    }));
    const r = evaluateDeadAir(
      metricsWith({ voice: { dead_air: deadAirBlock({ count: 6, max_ms: 4000, total_ms: 24000, events }) } }),
    );
    expect(r.detected).toBe(false);
  });

  test("scores the response gap on its own merits when both kinds are present", () => {
    // A huge caller pause must not drag the agent's short gap over the line —
    // the block's max_ms (20000) mixes both kinds, which is why the judge reads
    // the event list instead.
    const r = evaluateDeadAir(
      metricsWith({
        voice: {
          dead_air: deadAirBlock({
            count: 2, max_ms: 20000, total_ms: 23200,
            events: [
              { turn_number: 1, kind: "inter_turn", gap_ms: 20000 },
              { turn_number: 3, kind: "response", gap_ms: 3200 },
            ],
          }),
        },
      }),
    );
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);

    // ...and does fire when the agent's own gap crosses it.
    const r2 = evaluateDeadAir(
      metricsWith({
        voice: {
          dead_air: deadAirBlock({
            count: 2, max_ms: 20000, total_ms: 26000,
            events: [
              { turn_number: 1, kind: "inter_turn", gap_ms: 20000 },
              { turn_number: 3, kind: "response", gap_ms: DEAD_AIR_RESPONSE_MS + 1000 },
            ],
          }),
        },
      }),
    );
    expect(r2.detected).toBe(true);
    expect(r2.reason).toContain("turn 3");
    expect(r2.reason).toContain("6.0s"); // the response gap, not the 20s caller pause
  });

  test("is UNAVAILABLE when the block carries no per-event kinds", () => {
    // The aggregates mix both kinds and cannot be un-mixed; guessing would mean
    // blaming the agent for caller think-time.
    const r = evaluateDeadAir(
      metricsWith({ voice: { dead_air: { threshold_ms: 3000, count: 4, max_ms: 9000, total_ms: 20000 } } }),
    );
    expect(r.available).toBe(false);
    expect(r.detected).toBe(false);
  });

  test("a measured-but-empty dead-air block is a real clean verdict", () => {
    // gapMeasured was true (timestamps existed) but nothing crossed 3s.
    const r = evaluateDeadAir(metricsWith({ voice: { dead_air: deadAirBlock() } }));
    expect(r.available).toBe(true);
    expect(r.detected).toBe(false);
  });
});

describe("evaluateLatencyUx", () => {
  const agentTurns = (n: number) =>
    Array.from({ length: n }, () => ({ agent_text: "hi", user_text: null })) as any[];

  test("is UNAVAILABLE when neither latency nor interruption data exists", () => {
    const r = evaluateLatencyUx(metricsWith({}));
    expect(r.available).toBe(false);
    expect(r.detected).toBe(false);
  });

  test("fires on slow p95 responses", () => {
    const r = evaluateLatencyUx(metricsWith({ p95_user_perceived_ms: LATENCY_P95_MS + 1 }));
    expect(r.detected).toBe(true);
    expect(r.reason).toContain("95th percentile");
  });

  test("fires when the agent talks over the caller often enough", () => {
    const m = metricsWith({ interruptions: 5, interruption_rate: INTERRUPTION_RATE + 0.1 });
    m.turns = agentTurns(INTERRUPTION_MIN_AGENT_TURNS);
    const r = evaluateLatencyUx(m);
    expect(r.detected).toBe(true);
    expect(r.reason).toContain("spoke over the caller");
  });

  test("no latency AND a sub-floor turn count => UNAVAILABLE, not a pass", () => {
    // Regression: both axes unscoreable must not fall through to a clean verdict.
    // A pass here would be fanned out as a genuine "responsiveness was fine" row
    // backed by no measurement at all.
    const m = metricsWith({ interruptions: 1, interruption_rate: 0.5 });
    m.turns = agentTurns(2);
    const r = evaluateLatencyUx(m);
    expect(r.available).toBe(false);
    expect(r.detected).toBe(false);
    expect(r.technical_reason).toContain("undecidable");
  });

  test("does NOT fire on a high rate over too few turns", () => {
    // 1 interruption in 2 agent turns is 50% and means nothing. Latency IS
    // present here, so one axis is genuinely scored and the verdict is a real
    // (if partial) clean — see the sibling test for the both-unscoreable case.
    const m = metricsWith({
      p95_user_perceived_ms: LATENCY_P95_MS - 1,
      interruptions: 1,
      interruption_rate: 0.5,
    });
    m.turns = agentTurns(INTERRUPTION_MIN_AGENT_TURNS - 1);
    const r = evaluateLatencyUx(m);
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);
    // A clean verdict must admit the axis it declined to score.
    expect(r.technical_reason).toContain("not scored");
  });

  test("reports both failures together when both axes breach", () => {
    const m = metricsWith({
      p95_user_perceived_ms: LATENCY_P95_MS + 500,
      interruptions: 9,
      interruption_rate: INTERRUPTION_RATE + 0.2,
    });
    m.turns = agentTurns(10);
    const r = evaluateLatencyUx(m);
    expect(r.detected).toBe(true);
    expect(r.reason).toContain("95th percentile");
    expect(r.reason).toContain("spoke over");
  });

  test("stays clean when both axes are within bounds", () => {
    const m = metricsWith({
      p95_user_perceived_ms: LATENCY_P95_MS - 1,
      interruptions: 0,
      interruption_rate: 0,
    });
    m.turns = agentTurns(10);
    const r = evaluateLatencyUx(m);
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);
  });
});

describe("evaluateAgentScriptSwitch", () => {
  test("is UNAVAILABLE with no transcript or no agent speech", () => {
    expect(evaluateAgentScriptSwitch(undefined).available).toBe(false);
    expect(evaluateAgentScriptSwitch("   ").available).toBe(false);
    expect(evaluateAgentScriptSwitch("User: hello\nUser: anyone there?").available).toBe(false);
  });

  test("clean when the agent speaks Latin script throughout", () => {
    const r = evaluateAgentScriptSwitch("User: hi there\nAgent: Hello, how can I help?");
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);
  });

  test("fires when the agent switches script unilaterally", () => {
    const r = evaluateAgentScriptSwitch(
      "User: hi, is this about my move?\nAgent: नमस्ते, मैं आपकी मदद कर सकता हूँ।",
    );
    expect(r.detected).toBe(true);
    expect(r.reason).toContain("Devanagari");
    // Must not overclaim beyond what codepoints can prove.
    expect(r.technical_reason).toContain("Script-level detection only");
  });

  test("does NOT fire when the caller used that script too — a Hindi call is not a defect", () => {
    const r = evaluateAgentScriptSwitch(
      "User: नमस्ते\nAgent: नमस्ते, मैं आपकी मदद कर सकता हूँ।",
    );
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);
    expect(r.technical_reason).toContain("conducted in that script");
  });

  test("reads agent lines only — a non-Latin USER turn never implicates the agent", () => {
    const r = evaluateAgentScriptSwitch("User: 你好\nAgent: Sorry, I only speak English.");
    expect(r.detected).toBe(false);
  });

  // A turn's own text can contain newlines, so only its FIRST physical line
  // carries the role prefix. Measured at 6/329 calls on the EM corpus. Before
  // continuation lines inherited the speaker above them, both of these were wrong.
  test("regression: a script switch on a CONTINUATION line of an agent turn is caught", () => {
    const r = evaluateAgentScriptSwitch(
      "User: hi there\nAgent: Hello, this is your bank calling.\nनमस्ते, आपका खाता ब्लॉक हो गया है।",
    );
    expect(r.detected).toBe(true);
    expect(r.reason).toContain("Devanagari");
  });

  test("regression: a caller's CONTINUATION line counts as caller script usage", () => {
    // The caller did use Devanagari — on line 2 of their turn. Attributing only
    // prefixed lines would call this a unilateral agent switch. It is not.
    const r = evaluateAgentScriptSwitch(
      "User: hello\nनमस्ते, मुझे हिंदी में बात करनी है\nAgent: नमस्ते, बिल्कुल।",
    );
    expect(r.detected).toBe(false);
    expect(r.available).toBe(true);
  });

  test("text before any role prefix is dropped, not misattributed", () => {
    const r = evaluateAgentScriptSwitch("नमस्ते orphan preamble\nAgent: Hello there.");
    expect(r.detected).toBe(false);
  });

  test("an explicit expected script overrides the caller comparison", () => {
    // Caller happens to use Devanagari, but the agent is configured for Latin.
    const r = evaluateAgentScriptSwitch("User: नमस्ते\nAgent: नमस्ते जी", "Latin");
    expect(r.detected).toBe(true);
    expect(r.technical_reason).toContain("configured script Latin");
  });
});
