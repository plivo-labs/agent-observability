import { describe, test, expect } from "bun:test";
import { envSchema } from "../src/schema.js";

describe("envSchema", () => {
  const validEnv = {
    LIVEKIT_API_KEY: "my-api-key",
    LIVEKIT_API_SECRET: "my-api-secret",
    DATABASE_URL: "postgres://localhost:5432/test",
  };

  test("accepts valid minimal config", () => {
    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(9090);
      expect(result.data.AUTO_MIGRATE).toBe(false);
      expect(result.data.S3_REGION).toBe("us-east-1");
      expect(result.data.S3_PREFIX).toBe("recordings");
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

  test("fails when LIVEKIT_API_KEY is missing", () => {
    const { LIVEKIT_API_KEY, ...rest } = validEnv;
    const result = envSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("fails when LIVEKIT_API_SECRET is missing", () => {
    const { LIVEKIT_API_SECRET, ...rest } = validEnv;
    const result = envSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("fails when DATABASE_URL is missing", () => {
    const { DATABASE_URL, ...rest } = validEnv;
    const result = envSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("fails when LIVEKIT_API_KEY is empty string", () => {
    const result = envSchema.safeParse({ ...validEnv, LIVEKIT_API_KEY: "" });
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
