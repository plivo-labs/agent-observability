import type { JevClient, JevNoulAnswer, JevRequest, JevResponse } from "./types.js";

/** Probabilities keyed by question name, or a whole response. */
export type MockJevAnswers = Record<string, number> | JevResponse;
export type MockJevResponder = MockJevAnswers | Error | ((req: JevRequest) => MockJevAnswers | Error | Promise<MockJevAnswers | Error>);

/**
 * Deterministic in-memory Jev for tests — the MockLLM pattern. Queue one
 * responder per expected request; later requests reuse the last one. A
 * responder is a {questionKey: probability} map (keys the request asked for
 * but the map omits get `unansweredDefault`, or stay unanswered when that is
 * null), a full JevResponse, an Error to throw, or a function of the request.
 */
export class MockJev implements JevClient {
  readonly name = "mock-jev";
  readonly calls: JevRequest[] = [];
  private queue: MockJevResponder[];

  constructor(
    responses: MockJevResponder[] = [],
    private readonly unansweredDefault: number | null = 0.02,
  ) {
    this.queue = [...responses];
  }

  push(...responses: MockJevResponder[]): void {
    this.queue.push(...responses);
  }

  async systemOne(req: JevRequest): Promise<JevResponse> {
    this.calls.push(req);
    const next = this.queue.length > 1 ? this.queue.shift()! : (this.queue[0] ?? {});
    const value = typeof next === "function" ? await next(req) : next;
    if (value instanceof Error) throw value;
    if ("answers" in value && typeof value.answers === "object") return value as JevResponse;
    const answers: Record<string, JevNoulAnswer> = {};
    for (const key of Object.keys(req.questions)) {
      const p = (value as Record<string, number>)[key] ?? this.unansweredDefault;
      if (p !== null && p !== undefined) answers[key] = { type: "noul", noul: p };
    }
    return { model: "jev-mock", usage: { input_tokens: req.estTokens, output_tokens: Object.keys(answers).length }, answers };
  }
}
