// Reasoning-effort config → wire translation, and the schema keys that feed it.
//
// The "inherit" sentinel is the whole reason this helper exists: it is a valid
// CONFIG value and an invalid WIRE value. A role that forwards it verbatim would
// send `reasoning_effort: "inherit"` and get a 400 on every call, so the contract
// is asserted here once rather than re-derived at each of the four call sites.
import { describe, test, expect } from "bun:test";
import { resolveReasoningEffort } from "../src/llm/effort.js";
import { envSchema } from "../src/schema.js";

describe("resolveReasoningEffort", () => {
  test('"inherit" omits the parameter', () => {
    expect(resolveReasoningEffort("inherit")).toBeUndefined();
  });

  test("every real effort value passes through verbatim", () => {
    // "none" is the trap: it is a meaningful effort the provider accepts, not an
    // absence. A truthiness check anywhere in this path would drop it.
    expect(resolveReasoningEffort("none")).toBe("none");
    expect(resolveReasoningEffort("low")).toBe("low");
    expect(resolveReasoningEffort("medium")).toBe("medium");
    expect(resolveReasoningEffort("high")).toBe("high");
  });

  test("undefined falls back to the caller's default, not to a guessed effort", () => {
    // Tests and embedders replace the config module with a partial object, so an
    // undefined must resolve to what the ROLE declares — the judge's "none" parity
    // pin must survive a config mock that omits the key.
    expect(resolveReasoningEffort(undefined, "none")).toBe("none");
    expect(resolveReasoningEffort(undefined, "low")).toBe("low");
  });

  test("undefined with no explicit default omits the parameter", () => {
    // Safer than inventing an effort: a role that forgets to plumb its default
    // keeps the pre-existing wire shape instead of silently changing behavior.
    expect(resolveReasoningEffort(undefined)).toBeUndefined();
  });

  test('an explicit "inherit" default also omits', () => {
    expect(resolveReasoningEffort(undefined, "inherit")).toBeUndefined();
  });
});

describe("envSchema — generation + simulator effort knobs", () => {
  const parse = (env: Record<string, string> = {}) =>
    envSchema.parse({ ALLOW_UNAUTHENTICATED: "true", SIM_PERSIST: "false", ...env });

  test('all three default to "inherit" so merging changes no wire shape', () => {
    const c = parse();
    expect(c.SIM_EVAL_PLANNER_REASONING_EFFORT).toBe("inherit");
    expect(c.SIM_EVAL_WRITER_REASONING_EFFORT).toBe("inherit");
    expect(c.SIM_USER_REASONING_EFFORT).toBe("inherit");
  });

  test("accept every documented value and reject anything else", () => {
    for (const v of ["inherit", "none", "low", "medium", "high"] as const) {
      expect(parse({ SIM_EVAL_WRITER_REASONING_EFFORT: v }).SIM_EVAL_WRITER_REASONING_EFFORT).toBe(v);
    }
    // A rejected enum must fail at BOOT, not per-call: a bad effort value that
    // reaches the provider 400s every generation request instead of once.
    expect(() => parse({ SIM_EVAL_WRITER_REASONING_EFFORT: "minimal" })).toThrow();
    expect(() => parse({ SIM_EVAL_PLANNER_REASONING_EFFORT: "xhigh" })).toThrow();
    expect(() => parse({ SIM_USER_REASONING_EFFORT: "" })).toThrow();
  });

  test("the three knobs are independent", () => {
    const c = parse({
      SIM_EVAL_PLANNER_REASONING_EFFORT: "high",
      SIM_EVAL_WRITER_REASONING_EFFORT: "none",
      SIM_USER_REASONING_EFFORT: "low",
    });
    expect(c.SIM_EVAL_PLANNER_REASONING_EFFORT).toBe("high");
    expect(c.SIM_EVAL_WRITER_REASONING_EFFORT).toBe("none");
    expect(c.SIM_USER_REASONING_EFFORT).toBe("low");
  });
});

describe("envSchema — scenario generation model default", () => {
  test('defaults to "gpt-5.5", the deployment the AO Azure resources actually host', () => {
    // Regression guard for the previous default "gpt-5.5-1", a deployment on the
    // LEGACY SHARED Vibe resource. The dedicated AO resources do not host it, so
    // the old default could only ever resolve to DeploymentNotFound there.
    const c = envSchema.parse({ ALLOW_UNAUTHENTICATED: "true", SIM_PERSIST: "false" });
    expect(c.SIM_EVAL_SCENARIO_GENERATION_MODEL).toBe("gpt-5.5");
  });

  test("an explicit value still wins (the managed deployment always sets it)", () => {
    const c = envSchema.parse({
      ALLOW_UNAUTHENTICATED: "true",
      SIM_PERSIST: "false",
      SIM_EVAL_SCENARIO_GENERATION_MODEL: "gpt-5.6-luna",
    });
    expect(c.SIM_EVAL_SCENARIO_GENERATION_MODEL).toBe("gpt-5.6-luna");
  });
});
