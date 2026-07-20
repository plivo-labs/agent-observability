import { describe, expect, test } from "bun:test";
import {
  evaluateDeadAir,
  DEAD_AIR_RESPONSE_MS,
  DEAD_AIR_EVENT_COUNT,
} from "../src/evals-engine/judges/session-signal-judges.js";

// The code-derived dead-air judge. The single most important property under test
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
    // The caller pause stays deliberately LARGER than the agent's gap, so a
    // reason string quoting the wrong one is unmistakable.
    const agentGap = DEAD_AIR_RESPONSE_MS + 1000;
    const callerPause = agentGap * 2;
    const r2 = evaluateDeadAir(
      metricsWith({
        voice: {
          dead_air: deadAirBlock({
            count: 2, max_ms: callerPause, total_ms: callerPause + agentGap,
            events: [
              { turn_number: 1, kind: "inter_turn", gap_ms: callerPause },
              { turn_number: 3, kind: "response", gap_ms: agentGap },
            ],
          }),
        },
      }),
    );
    expect(r2.detected).toBe(true);
    expect(r2.reason).toContain("turn 3");
    // Quotes the agent's gap, never the (larger) caller pause. Derived from the
    // constant so a future threshold change doesn't silently invalidate this.
    expect(r2.reason).toContain(`${(agentGap / 1000).toFixed(1)}s`);
    expect(r2.reason).not.toContain(`${(callerPause / 1000).toFixed(1)}s`);
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
