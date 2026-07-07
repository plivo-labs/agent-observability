import type { LlmProvider, ProviderCompleteArgs, RawCompletion } from "./types.js";

type Responder = string | ((args: ProviderCompleteArgs) => string);

/**
 * Deterministic in-memory provider for tests and CI — no network, no API keys.
 * Queue one responder per expected call; later calls reuse the last responder
 * (or "{}" when the queue is empty). A responder can be a fixed string or a
 * function of the call args, which lets a test return garbage on attempt 1 and
 * valid JSON on attempt 2 to exercise completeJSON's retry path.
 */
export class MockLLM implements LlmProvider {
  readonly name = "mock";
  private queue: Responder[];
  /** Recorded calls, in order — assert on prompt content / model in tests. */
  readonly calls: ProviderCompleteArgs[] = [];

  constructor(responses: Responder[] = []) {
    this.queue = [...responses];
  }

  push(...responses: Responder[]): void {
    this.queue.push(...responses);
  }

  async complete(args: ProviderCompleteArgs): Promise<RawCompletion> {
    this.calls.push(args);
    const next = this.queue.length > 1 ? this.queue.shift()! : (this.queue[0] ?? "{}");
    const text = typeof next === "function" ? next(args) : next;
    return { text, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  }
}
