import { describe, test, expect } from "bun:test";
import { envSchema, assertProdAuthConfigured } from "../src/schema.js";

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

  test("fails when DATABASE_URL is missing", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
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

  test("NODE_ENV defaults to development, accepts known modes, rejects others", () => {
    const def = envSchema.safeParse(validEnv);
    expect(def.success).toBe(true);
    if (def.success) expect(def.data.NODE_ENV).toBe("development");

    for (const env of ["development", "production", "test"]) {
      expect(envSchema.safeParse({ ...validEnv, NODE_ENV: env }).success).toBe(true);
    }
    expect(envSchema.safeParse({ ...validEnv, NODE_ENV: "staging" }).success).toBe(false);
  });
});

describe("assertProdAuthConfigured", () => {
  test("dev without auth is allowed (zero-config open mode)", () => {
    expect(() => assertProdAuthConfigured("development", false)).not.toThrow();
  });

  test("test env without auth is allowed", () => {
    expect(() => assertProdAuthConfigured("test", false)).not.toThrow();
  });

  test("production without auth throws (fail-fast boot)", () => {
    expect(() => assertProdAuthConfigured("production", false)).toThrow(
      /NODE_ENV=production but no authentication/,
    );
  });

  test("production with auth is allowed", () => {
    expect(() => assertProdAuthConfigured("production", true)).not.toThrow();
  });
});
