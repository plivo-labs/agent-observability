import { describe, test, expect } from "bun:test";
import { envSchema } from "../src/schema.js";

describe("envSchema", () => {
  const validEnv = {
    DATABASE_URL: "postgres://localhost:5432/test",
  };

  test("accepts valid minimal config (no auth)", () => {
    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(9090);
      expect(result.data.AUTO_MIGRATE).toBe(false);
      expect(result.data.S3_REGION).toBe("us-east-1");
      expect(result.data.S3_PREFIX).toBe("recordings");
      expect(result.data.AGENT_OBSERVABILITY_USER).toBeUndefined();
      expect(result.data.AGENT_OBSERVABILITY_PASS).toBeUndefined();
      expect(result.data.LIVEKIT_API_KEY).toBeUndefined();
      expect(result.data.LIVEKIT_API_SECRET).toBeUndefined();
    }
  });

  test("ALERT_SWEEPER defaults to inline, accepts off, rejects unknown modes", () => {
    const def = envSchema.safeParse(validEnv);
    expect(def.success).toBe(true);
    if (def.success) expect(def.data.ALERT_SWEEPER).toBe("inline");

    const off = envSchema.safeParse({ ...validEnv, ALERT_SWEEPER: "off" });
    expect(off.success).toBe(true);
    if (off.success) expect(off.data.ALERT_SWEEPER).toBe("off");

    expect(envSchema.safeParse({ ...validEnv, ALERT_SWEEPER: "worker" }).success).toBe(false);
  });

  test("accepts config with basic auth credentials", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      AGENT_OBSERVABILITY_USER: "admin",
      AGENT_OBSERVABILITY_PASS: "secret",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AGENT_OBSERVABILITY_USER).toBe("admin");
      expect(result.data.AGENT_OBSERVABILITY_PASS).toBe("secret");
    }
  });

  test("auth credentials are optional", () => {
    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  test("accepts LiveKit upload auth credentials", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      LIVEKIT_API_KEY: "plivo-labs-livekit-api-key",
      LIVEKIT_API_SECRET: "plivo-labs-livekit-api-secret",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.LIVEKIT_API_KEY).toBe("plivo-labs-livekit-api-key");
      expect(result.data.LIVEKIT_API_SECRET).toBe("plivo-labs-livekit-api-secret");
    }
  });

  test("applies PORT default", () => {
    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(9090);
    }
  });

  test("coerces PORT from string", () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: "3000" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3000);
    }
  });

  test("parses AUTO_MIGRATE=true", () => {
    const result = envSchema.safeParse({ ...validEnv, AUTO_MIGRATE: "true" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AUTO_MIGRATE).toBe(true);
    }
  });

  test("parses AUTO_MIGRATE=1", () => {
    const result = envSchema.safeParse({ ...validEnv, AUTO_MIGRATE: "1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AUTO_MIGRATE).toBe(true);
    }
  });

  test("parses AUTO_MIGRATE=false", () => {
    const result = envSchema.safeParse({ ...validEnv, AUTO_MIGRATE: "false" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.AUTO_MIGRATE).toBe(false);
    }
  });

  test("DATABASE_URL is optional (stateless mode — SIM_PERSIST=false deploys run with no DB)", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.DATABASE_URL).toBeUndefined();
    }
  });

  test("accepts full S3 config", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      S3_BUCKET: "my-bucket",
      S3_REGION: "eu-west-1",
      S3_ACCESS_KEY_ID: "AKID",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_ENDPOINT: "https://s3.example.com",
      S3_PREFIX: "custom-prefix",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.S3_BUCKET).toBe("my-bucket");
      expect(result.data.S3_REGION).toBe("eu-west-1");
      expect(result.data.S3_PREFIX).toBe("custom-prefix");
    }
  });

  test("S3 fields are optional", () => {
    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.S3_BUCKET).toBeUndefined();
      expect(result.data.S3_ACCESS_KEY_ID).toBeUndefined();
      expect(result.data.S3_SECRET_ACCESS_KEY).toBeUndefined();
    }
  });
});

describe("envSchema — reasoning-effort knobs", () => {
  // Every effort key is parsed straight into the value the provider accepts: the "inherit"
  // sentinel is collapsed to undefined HERE, at the boundary, so no downstream role can ship
  // it on the wire. These tests pin that boundary — they are the reason no call site needs a
  // translation step.
  const parse = (env: Record<string, string> = {}) =>
    envSchema.parse({ ALLOW_UNAUTHENTICATED: "true", SIM_PERSIST: "false", ...env });

  test('"inherit" parses to undefined — the parameter is omitted, not sent', () => {
    const c = parse({
      JUDGE_REASONING_EFFORT: "inherit",
      SIM_EVAL_PLANNER_REASONING_EFFORT: "inherit",
      SIM_EVAL_WRITER_REASONING_EFFORT: "inherit",
      SIM_USER_REASONING_EFFORT: "inherit",
    });
    expect(c.JUDGE_REASONING_EFFORT).toBeUndefined();
    expect(c.SIM_EVAL_PLANNER_REASONING_EFFORT).toBeUndefined();
    expect(c.SIM_EVAL_WRITER_REASONING_EFFORT).toBeUndefined();
    expect(c.SIM_USER_REASONING_EFFORT).toBeUndefined();
  });

  test("each key keeps its OWN unset default", () => {
    // The judge default is a real effort ("none", reference-engine parity); the three
    // generation/simulator keys default to omitting the parameter. Collapsing them to one
    // shared default would silently change judge behaviour.
    const c = parse();
    expect(c.JUDGE_REASONING_EFFORT).toBe("none");
    expect(c.SIM_EVAL_PLANNER_REASONING_EFFORT).toBeUndefined();
    expect(c.SIM_EVAL_WRITER_REASONING_EFFORT).toBeUndefined();
    expect(c.SIM_USER_REASONING_EFFORT).toBeUndefined();
  });

  test('"none" survives as a real effort — it is not treated as absence', () => {
    // The trap this guards: "none" is a meaningful instruction ("do not reason"), NOT the
    // same as omitting the parameter. A truthiness check anywhere in this path would drop it.
    expect(parse({ SIM_EVAL_WRITER_REASONING_EFFORT: "none" }).SIM_EVAL_WRITER_REASONING_EFFORT).toBe("none");
  });

  test("real efforts pass through, and the keys are independent", () => {
    const c = parse({
      SIM_EVAL_PLANNER_REASONING_EFFORT: "high",
      SIM_EVAL_WRITER_REASONING_EFFORT: "low",
      SIM_USER_REASONING_EFFORT: "medium",
    });
    expect(c.SIM_EVAL_PLANNER_REASONING_EFFORT).toBe("high");
    expect(c.SIM_EVAL_WRITER_REASONING_EFFORT).toBe("low");
    expect(c.SIM_USER_REASONING_EFFORT).toBe("medium");
  });

  test("an invalid effort fails at BOOT, not per-request", () => {
    // A bad value that reached the provider would 400 every single call on that path.
    expect(() => parse({ SIM_EVAL_WRITER_REASONING_EFFORT: "minimal" })).toThrow();
    expect(() => parse({ JUDGE_REASONING_EFFORT: "xhigh" })).toThrow();
    expect(() => parse({ SIM_USER_REASONING_EFFORT: "" })).toThrow();
  });
});

describe("envSchema — scenario generation model default", () => {
  test('defaults to "gpt-5.5", the deployment the AO Azure resources actually host', () => {
    // Regression guard for the previous default "gpt-5.5-1", a deployment on the LEGACY
    // SHARED Vibe resource that the dedicated AO resources do not host — so the old default
    // could only ever resolve to DeploymentNotFound there.
    const c = envSchema.parse({ ALLOW_UNAUTHENTICATED: "true", SIM_PERSIST: "false" });
    expect(c.SIM_EVAL_SCENARIO_GENERATION_MODEL).toBe("gpt-5.5");
  });
});
