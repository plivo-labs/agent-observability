import { describe, test, expect } from "bun:test";
import { DEFAULT_GATES, decide, gateFor, resolveGates, NEVER_FAIL, NEVER_PASS } from "../src/jev/gates.js";

describe("decide", () => {
  const g = { pass_below: 0.2, fail_above: 0.8 };
  test("boundaries are inclusive on both sides", () => {
    expect(decide(0.2, g)).toBe("pass");
    expect(decide(0.8, g)).toBe("fail");
    expect(decide(0.21, g)).toBe("review");
    expect(decide(0.79, g)).toBe("review");
    expect(decide(0, g)).toBe("pass");
    expect(decide(1, g)).toBe("fail");
  });
  test("hallucination never auto-fails, adherence never auto-passes", () => {
    expect(decide(1, DEFAULT_GATES.hallucination!)).toBe("review");
    expect(decide(0.05, DEFAULT_GATES.hallucination!)).toBe("pass");
    expect(decide(0, DEFAULT_GATES.instructions_adherence!)).toBe("review");
    expect(decide(0.95, DEFAULT_GATES.instructions_adherence!)).toBe("fail");
  });
});

describe("resolveGates", () => {
  test("no override returns the defaults", () => {
    expect(resolveGates(undefined)).toEqual({ ...DEFAULT_GATES });
    expect(resolveGates("  ")).toEqual({ ...DEFAULT_GATES });
  });
  test("overlays valid entries, ignores invalid ones with a warning, keeps the rest", () => {
    const warnings: string[] = [];
    const gates = resolveGates(
      JSON.stringify({ bot_detection: { pass_below: 0.2, fail_above: 0.8 }, node_loop: { pass_below: 0.9, fail_above: 0.1 }, "metric:x": { pass_below: 0.1, fail_above: 0.95 } }),
      (m) => warnings.push(m),
    );
    expect(gates.bot_detection).toEqual({ pass_below: 0.2, fail_above: 0.8 });
    expect(gates.node_loop).toEqual(DEFAULT_GATES.node_loop);
    expect(gates["metric:x"]).toEqual({ pass_below: 0.1, fail_above: 0.95 });
    expect(warnings.some((w) => w.includes("node_loop"))).toBe(true);
  });
  test("malformed JSON keeps defaults and warns once", () => {
    const warnings: string[] = [];
    expect(resolveGates("{not json", (m) => warnings.push(m))).toEqual({ ...DEFAULT_GATES });
    expect(warnings).toHaveLength(1);
    expect(resolveGates("[1,2]", (m) => warnings.push(m))).toEqual({ ...DEFAULT_GATES });
  });
  test("sentinels are accepted from the override", () => {
    const gates = resolveGates(JSON.stringify({ hallucination: { pass_below: NEVER_PASS, fail_above: NEVER_FAIL } }));
    expect(decide(0, gates.hallucination!)).toBe("review");
  });
});

describe("gateFor", () => {
  test("custom metrics share one gate; unknown judges have none", () => {
    expect(gateFor(DEFAULT_GATES, "metric:hold_warning")).toEqual(DEFAULT_GATES.custom_metric);
    expect(gateFor(DEFAULT_GATES, "stt")).toBeUndefined();
  });
});
