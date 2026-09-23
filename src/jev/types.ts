// Jev (TypeSafe System One) wire contract, as the official SDK serializes it:
// POST /v1/systemone {model, state, questions} -> {model, usage, answers}.
// Only the Noul (yes/no) primitive is used: every AO judge is a defect
// probability, and Choice/Score were measured to add nothing here.

export interface JevNoul {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/** One HTTP request: a state object and the named questions asked over it. */
export interface JevRequest {
  /** Stable per-session identifier (e.g. "n0", "v0", "h0", "c") — for logs and
   *  for mapping answers back to axes; never sent to the model. */
  key: string;
  state: unknown;
  questions: Record<string, JevNoul>;
  /** Estimated state tokens PLUS the longest question — the number Jev caps at
   *  ~32k (see tokens.ts; the estimate is deliberately conservative). */
  estTokens: number;
  /** Estimated state plus EVERY question — Jev's other cap, ~64k. */
  estTotalTokens: number;
}

export interface JevNoulAnswer {
  type: "noul";
  /** Probability of the `true` criterion, 0..1. */
  noul: number;
}

export interface JevResponse {
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Keyed by question name. A key we asked for may be absent — the
   *  orchestrator treats that as "unanswered", never as a probability. */
  answers: Record<string, JevNoulAnswer>;
}

export interface JevClient {
  readonly name: string;
  systemOne(req: JevRequest): Promise<JevResponse>;
}

/** Message shape `jev <status> <error_type>` is what error-durability.ts
 *  keys on (429 / 5xx / "overloaded" / timeout read as transient). */
export class JevError extends Error {
  /** Server-suggested wait before a retry (429/529), when the header was present. */
  retryAfterMs: number | null = null;
  constructor(
    readonly status: number,
    readonly errorType: string,
    detail?: string,
  ) {
    super(`jev ${status} ${errorType}${detail ? `: ${detail}` : ""}`);
    this.name = "JevError";
  }
}

export const JEV_OVERFLOW = "max_tokens_exceeded";
