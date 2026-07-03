import { describe, test, expect } from "bun:test";
import { envSchema } from "../src/schema.js";

// Stage 1: the run-engine env vars parse with the right defaults + coercion. envSchema is a
// pure zod object (parsing happens in config.ts, not here), so this needs no real env beyond
// the single required field.
const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("envSchema — run-engine vars", () => {
  test("apply defaults when unset", () => {
    const env = envSchema.parse(base);
    expect(env.SIM_REDIS_PREFIX).toBe("SIM_EVAL");
    expect(env.SIM_WORKER_CONCURRENCY).toBe(8);
    expect(env.LIVEKIT_SIM_TURN_URL).toBeUndefined();
    expect(env.USER_SIMULATOR_MODEL).toBeUndefined();
  });

  test("honor overrides + coerce SIM_WORKER_CONCURRENCY to a number", () => {
    const env = envSchema.parse({
      ...base,
      SIM_REDIS_PREFIX: "OSS_SIM",
      SIM_WORKER_CONCURRENCY: "16",
      LIVEKIT_SIM_TURN_URL: "http://livekit.internal:8080",
      USER_SIMULATOR_MODEL: "gpt-5.5-1",
    });
    expect(env.SIM_REDIS_PREFIX).toBe("OSS_SIM");
    expect(env.SIM_WORKER_CONCURRENCY).toBe(16);
    expect(env.LIVEKIT_SIM_TURN_URL).toBe("http://livekit.internal:8080");
    expect(env.USER_SIMULATOR_MODEL).toBe("gpt-5.5-1");
  });

  test("reject a non-positive SIM_WORKER_CONCURRENCY", () => {
    expect(envSchema.safeParse({ ...base, SIM_WORKER_CONCURRENCY: "0" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, SIM_WORKER_CONCURRENCY: "-2" }).success).toBe(false);
  });
});
