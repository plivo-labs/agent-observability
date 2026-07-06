import { describe, test, expect, mock } from "bun:test";

// Mock config so importing sim-engine/config doesn't parse real env (which would
// require DATABASE_URL and could process.exit). This mock is a FULLY-configured,
// QUEUE-mode deploy so the derived gates below have a concrete shape to assert.
mock.module("../src/config.js", () => ({
  config: {
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: undefined,
    SIM_EVAL_SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/eval",
    REDIS_URL: "redis://localhost:6379",
    AWS_REGION: "us-east-1",
    SIM_EVAL_SCENARIO_GENERATION_MODEL: "gpt-5.5-1",
    SIM_REDIS_PREFIX: "SIM_EVAL",
    LIVEKIT_SIM_TURN_URL: "http://livekit.test",
    SIM_WORKER_CONCURRENCY: 4,
    SIM_PERSIST: true,
    // USER_SIMULATOR_MODEL intentionally omitted → falls back to the generation model
  },
  dbConfigured: true,
}));

const {
  isSimEngineEnabled,
  isLlmConfigured,
  isRunEnabled,
  generationEnabled,
  runEnabled,
  queueDispatchEnabled,
  simFeatureEnabled,
  simEngineConfig,
} = await import("../src/sim-engine/config.js");

describe("sim-engine capability gates (pure helpers)", () => {
  test("isSimEngineEnabled: queue-dispatch prereq = sqs AND redis", () => {
    expect(isSimEngineEnabled("q", "r")).toBe(true);
    expect(isSimEngineEnabled("q", undefined)).toBe(false);
    expect(isSimEngineEnabled(undefined, "r")).toBe(false);
    expect(isSimEngineEnabled(undefined, undefined)).toBe(false);
    // Empty strings are unset, not configured.
    expect(isSimEngineEnabled("", "")).toBe(false);
  });

  test("isLlmConfigured: the SELECTED provider's key must be present", () => {
    expect(isLlmConfigured("openai", undefined, "sk")).toBe(true);
    expect(isLlmConfigured("openai", "anthropic-key", undefined)).toBe(false); // wrong provider's key
    expect(isLlmConfigured("anthropic", "anthropic-key", undefined)).toBe(true);
    expect(isLlmConfigured("anthropic", undefined, "sk")).toBe(false);
    expect(isLlmConfigured("openai", undefined, undefined)).toBe(false);
  });

  test("isRunEnabled: needs Redis AND a /turn endpoint (both dispatch modes)", () => {
    expect(isRunEnabled("redis://x", "http://turn")).toBe(true);
    expect(isRunEnabled("redis://x", undefined)).toBe(false);
    expect(isRunEnabled(undefined, "http://turn")).toBe(false);
    expect(isRunEnabled(undefined, undefined)).toBe(false);
  });
});

// The derived constants are computed at sim-engine/config.js import. When the whole tests/ suite
// runs in one process, a sibling may import that module FIRST (with the real env), so this file's
// mock.module no-ops (documented constraint: config-mock tests are reliable only per-file). Detect
// that and skip the mock-dependent assertions in aggregate runs — the pure-helper tests above
// already cover the gate LOGIC deterministically. Run this file alone to exercise the full set.
const mockActive = simEngineConfig.livekitSimTurnUrl === "http://livekit.test";
if (!mockActive) {
  console.warn("[sim-engine-config] mock.module no-op (config imported by a sibling first) — skipping derived-gate assertions; run this file alone for full coverage");
}

describe("sim-engine derived gates (fully-configured queue-mode mock)", () => {
  test.skipIf(!mockActive)("each capability lights up on its own prerequisites", () => {
    expect(generationEnabled).toBe(true); // OPENAI_API_KEY set
    expect(runEnabled).toBe(true); // REDIS_URL + LIVEKIT_SIM_TURN_URL set
    expect(queueDispatchEnabled).toBe(true); // sqs + redis + run
    expect(simFeatureEnabled).toBe(true); // generation || runs
  });

  test.skipIf(!mockActive)("config view reflects the (mocked) env", () => {
    expect(simEngineConfig.sqsQueueUrl).toContain("amazonaws.com");
    expect(simEngineConfig.scenarioGenerationModel).toBe("gpt-5.5-1");
    expect(simEngineConfig.simRedisPrefix).toBe("SIM_EVAL");
    expect(simEngineConfig.workerConcurrency).toBe(4);
    expect(simEngineConfig.livekitSimTurnUrl).toBe("http://livekit.test");
    expect(simEngineConfig.userSimulatorModel).toBe("gpt-5.5-1"); // fallback to generation model
  });
});
