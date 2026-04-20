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
    }
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
});
