/** Shared minimum config for tests that import eval judge modules.
 *
 * Keep the semaphore limit here: an incomplete config mock must not turn an
 * otherwise unrelated judge test into a five-second deadlock.
 */
export const TEST_JUDGE_CONFIG = {
  LLM_PROVIDER: "anthropic",
  JUDGE_MODEL: undefined,
  SIMULATOR_MODEL: undefined,
  GENERATOR_MODEL: undefined,
  LLM_TIMEOUT_MS: 30_000,
  LLM_MAX_RETRIES: 1,
  EVAL_MAX_CONCURRENT_JUDGE_CALLS: 10,
} as const;
