/** Shared minimum config for tests that import eval judge modules.
 *
 * Keep the semaphore limit here: an incomplete config mock must not turn an
 * otherwise unrelated judge test into a five-second deadlock.
 */
export const TEST_JUDGE_CONFIG = {
  LLM_PROVIDER: "anthropic",
  // Pinned so resolveModel() doesn't hit its unset-model fallback (and the accompanying
  // warning) on every judge test. A test that specifically exercises the unset path should
  // override this to undefined locally rather than the production code special-casing mocks.
  JUDGE_MODEL: "test-judge-model",
  SIMULATOR_MODEL: undefined,
  GENERATOR_MODEL: undefined,
  LLM_TIMEOUT_MS: 30_000,
  LLM_MAX_RETRIES: 1,
  EVAL_MAX_CONCURRENT_JUDGE_CALLS: 10,
  // Reference-engine parity knob read by run-llm-judge on every judge call.
  JUDGE_REASONING_EFFORT: "none",
  // Jev first-pass judge: off by default so every existing judge test keeps
  // today's LLM-only call sequence; jev-* suites inject a MockJev explicitly.
  JEV_MODE: "off",
  JEV_API_KEY: undefined,
  JEV_BASE_URL: "https://api.typesafe.ai",
  JEV_MODEL: "jev-1.13.0",
  JEV_TIMEOUT_MS: 15_000,
  JEV_MAX_CONCURRENT: 8,
  JEV_JUDGES: "all",
  JEV_CUSTOM_METRICS: "off",
  JEV_GATES: undefined,
  JEV_STATE_TOKEN_BUDGET: 30_000,
} as const;

/** Complete src/config.js module shape for Bun's process-wide module mocks.
 * A judge test can load before unrelated route/auth tests in CI, so omitting
 * named exports here would make those later imports fail at module linkage. */
export const TEST_CONFIG_MODULE_DEFAULTS = {
  dbConfigured: false,
  s3Enabled: false,
  basicAuthEnabled: false,
  liveKitAuthEnabled: false,
} as const;

export const TEST_JUDGE_CONFIG_MODULE = {
  ...TEST_CONFIG_MODULE_DEFAULTS,
  config: TEST_JUDGE_CONFIG,
} as const;
