// AO Simulation Engine — agent runtime /turn client.
//
// Port of the reference worker `usecases/simulation_eval/livekit_client.go`. One synchronous HTTP
// call per turn: the engine sends the simulated caller's message + the threaded conversation
// state; livekit runs the CXAgent for a single turn and returns its reply, the detected intent,
// updated variables, and the state to thread into the next turn.
//
// The AO↔livekit hop is plain HTTP (no Redis). The agent runtime is unauthenticated on the
// private network; optional Basic auth is supported via constructor opts to mirror the Go client.

import { simEngineConfig } from "../config.js";

const TURN_PATH = "/v1/simulation/session/turn";
const DEFAULT_TIMEOUT_MS = 60_000; // matches the Go client's 60s http.Client timeout
const MAX_ERROR_PREVIEW = 500; // matches the Go client's 500-char error body preview

/** Request body for POST {base}{TURN_PATH} — mirrors livekit_client.go `LiveKitSimRequest`.
 *  Optional fields are omitted from the wire body when undefined (Go's `omitempty`); the
 *  always-present `is_interruption` mirrors the Go field's lack of omitempty. */
export interface LiveKitSimRequest {
  phlo_run_uuid: string;
  /** Session id livekit uses for conversation continuity across turns; set to the flow_run_uuid
   *  (mirrors the reference worker, which defaults it to phlo_run_uuid). */
  simulation_session_id?: string;
  node_uuid: string;
  node_run_uuid: string;
  auth_id: string;
  /** The simulated caller's utterance for this turn (omitted on the opening agent turn). */
  user_message?: string;
  is_interruption: boolean;
  partial_assistant_message?: string;
  agent_config?: Record<string, unknown>;
  action_mocks?: Record<string, unknown>;
  /** Opaque conversation context items, threaded back verbatim each turn. */
  context_items?: unknown[];
  variables_by_node?: Record<string, Record<string, unknown>>;
}

/** Response body — mirrors livekit_client.go `LiveKitSimResponse`. */
export interface LiveKitSimResponse {
  /** Session id echoed back by livekit (informational; continuity is keyed on the request value). */
  simulation_session_id?: string;
  /** "speech" | "transition" — whether the agent actually spoke this turn or silently transitioned nodes. */
  turn_type?: string;
  /** Convenience flag from livekit; AO derives its own via isSpokenTurn() to match the Go normalization. */
  is_spoken?: boolean;
  message: string;
  intent: string;
  variables: Record<string, unknown>;
  tool_calls: unknown[];
  response_items: unknown[];
  node_uuid: string;
  node_run_uuid: string;
  ended: boolean;
  stop_reason: string;
  context_items: unknown[];
  variables_by_node: Record<string, Record<string, unknown>>;
}

// Turn-type constants + helpers — faithful port of livekit_client.go:20-101. A "transition" turn is a
// silent node handoff (no spoken agent utterance); it must NOT be fed to the simulator or written to history,
// otherwise the simulator sees a phantom/empty agent turn and the conversation diverges (turn count).
export const LIVEKIT_TURN_TYPE_SPEECH = "speech";
export const LIVEKIT_TURN_TYPE_TRANSITION = "transition";

/** Port of Go `hasHandoffToolCall`: any tool call whose `name` starts with "handoff_". */
export function hasHandoffToolCall(toolCalls: unknown[] | undefined): boolean {
  if (!toolCalls) return false;
  for (const raw of toolCalls) {
    const name = (raw as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.startsWith("handoff_")) return true;
  }
  return false;
}

/** Port of Go `NormalizedTurnType`: explicit turn_type wins; else speech if a message exists; else
 *  transition if a handoff tool call is present; else speech. */
export function normalizedTurnType(resp: LiveKitSimResponse): string {
  const tt = (resp.turn_type ?? "").trim();
  if (tt !== "") return tt;
  if ((resp.message ?? "").trim() !== "") return LIVEKIT_TURN_TYPE_SPEECH;
  if (hasHandoffToolCall(resp.tool_calls)) return LIVEKIT_TURN_TYPE_TRANSITION;
  return LIVEKIT_TURN_TYPE_SPEECH;
}

/** Port of Go `IsSpokenTurn`: a real agent utterance to record (speech + non-empty message). */
export function isSpokenTurn(resp: LiveKitSimResponse): boolean {
  return normalizedTurnType(resp) === LIVEKIT_TURN_TYPE_SPEECH && (resp.message ?? "").trim() !== "";
}

/** Port of Go `IsTransitionTurn`: a silent node transition (no spoken reply). */
export function isTransitionTurn(resp: LiveKitSimResponse): boolean {
  return normalizedTurnType(resp) === LIVEKIT_TURN_TYPE_TRANSITION;
}

export interface LiveKitSimClientOptions {
  /** Base URL; defaults to simEngineConfig.livekitSimTurnUrl (LIVEKIT_SIM_TURN_URL). */
  url?: string;
  /** Optional Basic-auth credentials (livekit is unauthenticated on the managed deployment's private network). */
  username?: string;
  password?: string;
  /** Per-request timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

/** Thrown on any /turn failure (unconfigured URL, timeout, non-200, or unparseable body). */
export class LiveKitSimError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LiveKitSimError";
    this.status = status;
  }
}

export class LiveKitSimClient {
  private readonly url: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Per-session cookie store (sessionId → "name=value; name2=value2"), mirroring the Go client's
   *  per-session cookiejar (livekit_client.go:239-263) so all turns of a session carry the sticky
   *  LB cookie. Bun's fetch has no auto cookie jar, so we persist + resend Set-Cookie pairs manually. */
  private readonly sessionCookies = new Map<string, string>();

  constructor(opts: LiveKitSimClientOptions = {}) {
    this.url = opts.url ?? simEngineConfig.livekitSimTurnUrl ?? "";
    this.username = opts.username ?? "";
    this.password = opts.password ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Run one simulation turn against livekit's /v1/simulation/session/turn endpoint. */
  async executeTurn(req: LiveKitSimRequest): Promise<LiveKitSimResponse> {
    if (!this.url) throw new LiveKitSimError("livekit sim URL not configured");
    return this.post(TURN_PATH, req);
  }

  private authHeader(): Record<string, string> {
    if (!this.username && !this.password) return {};
    const token = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  /** Merge the response's Set-Cookie pairs into the per-session jar (name-keyed, like Go's cookiejar). */
  private storeCookies(sessionId: string, resp: Response): void {
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;
    const jar = new Map<string, string>();
    const existing = this.sessionCookies.get(sessionId);
    if (existing) {
      for (const pair of existing.split("; ")) {
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    for (const sc of setCookies) {
      const first = (sc.split(";")[0] ?? "").trim(); // drop attributes (Path/Expires/…), keep name=value
      const eq = first.indexOf("=");
      if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
    this.sessionCookies.set(
      sessionId,
      [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    );
  }

  private async post(path: string, req: LiveKitSimRequest): Promise<LiveKitSimResponse> {
    const url = `${this.url}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Per-session cookie affinity: send the stored jar for this session (if any).
    const sessionId = req.simulation_session_id ?? "";
    const cookieHeader = sessionId ? this.sessionCookies.get(sessionId) : undefined;

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeader(),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        // JSON.stringify drops undefined keys → matches the Go client's `omitempty` for optionals.
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LiveKitSimError(`livekit sim ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new LiveKitSimError(`livekit sim request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    // Persist any Set-Cookie for this session so subsequent turns reuse it (sticky routing parity).
    if (sessionId) this.storeCookies(sessionId, resp);

    const body = await resp.text();
    if (resp.status !== 200) {
      const preview = body.length > MAX_ERROR_PREVIEW ? body.slice(0, MAX_ERROR_PREVIEW) : body;
      throw new LiveKitSimError(`livekit sim ${path} returned status ${resp.status}: ${preview}`, resp.status);
    }

    try {
      return JSON.parse(body) as LiveKitSimResponse;
    } catch (err) {
      throw new LiveKitSimError(`failed to decode response: ${(err as Error).message}`);
    }
  }
}

/** Factory mirroring Go's NewLiveKitSimClient(): base URL from config, optional Basic creds via opts. */
export function makeLiveKitSimClient(opts: LiveKitSimClientOptions = {}): LiveKitSimClient {
  return new LiveKitSimClient(opts);
}
