import type { LlmProvider, ProviderCompleteArgs, RawCompletion } from "./types.js";

type Responder = string | ((args: ProviderCompleteArgs) => string | Promise<string>);

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
    // A responder may be async (e.g. Bun.sleep before responding) so tests can model
    // slow LLM calls and assert completion-order behavior.
    const text = typeof next === "function" ? await next(args) : next;
    // Mirror a streaming provider deterministically: feed the response through the
    // live text sink in fixed-size deltas before returning — exercises incremental
    // consumers (the writer's stream extractor) on every mocked call.
    if (args.onText) {
      for (let i = 0; i < text.length; i += 16) args.onText(text.slice(i, i + 16));
    }
    return { text, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  }
}
