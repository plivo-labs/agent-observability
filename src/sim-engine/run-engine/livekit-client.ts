// AO Simulation Engine — agent-runner simulation client (SER-6447).
//
// The flow walk now lives in agent-runner: AO sends the canonical `flow` + `world_state`
// per turn and agent-runner owns entry resolution, edge resolution, branch evaluation and
// non-AI node execution. This one client wraps the four surfaces AO drives:
//   - turn()                       POST /v1/simulation/session/turn        (stateless ai_agent_v2 turn)
//   - flowSessionStart/Turn/End()  POST /v1/simulation/flow-session/{...}  (server-held task units)
//   - inventory()                  POST /v1/simulation/flow/inventory      (generator dry-run, no LLM)
//
// Request bodies are byte-for-byte the agent-runner `SimTurnRequest` (extra="forbid", so every
// key must exist there); the timeout covers the body read; and a per-session cookie jar keeps
// task-unit turns pinned to the container holding their session (ALB stickiness parity).

import { simEngineConfig } from "../config.js";
import type { FlowInventory } from "../gen/inventory.js";

const TURN_PATH = "/v1/simulation/session/turn";
const FLOW_SESSION_START_PATH = "/v1/simulation/flow-session/start";
const FLOW_SESSION_TURN_PATH = "/v1/simulation/flow-session/turn";
const FLOW_SESSION_END_PATH = "/v1/simulation/flow-session/end";
const INVENTORY_PATH = "/v1/simulation/flow/inventory";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_PREVIEW = 500;

/** Request body for the /session/turn and /flow-session/* endpoints — the agent-runner
 *  `SimTurnRequest` (schema.py). `extra="forbid"` on the server, so no key outside this
 *  set may ever be sent (the old `agent_config` / `output_state_config` / `is_interruption`
 *  / `partial_assistant_message` fields are gone — agent-runner builds config from `flow`). */
export interface SimTurnRequest {
  phlo_run_uuid: string;
  auth_id: string;
  /** Keys the server-held session on the flow-session endpoints (+ the cookie jar); unused by /session/turn. */
  simulation_session_id?: string;
  /** Canonical FLOW_JSON (Shape B). Resent every turn; agent-runner caches the parse by sha256. */
  flow: Record<string, unknown>;
  /** {node_id | config_name: {outcome?, data?, action_mocks?}} — pins mocked outcomes + seeds vars. */
  world_state?: Record<string, unknown>;
  /** Seeded under the trigger's prod namespace on the entry walk. */
  start_node_params?: Record<string, unknown>;
  max_turns: number;
  /** "" on the first call ⇒ agent-runner resolves entry from Start. */
  node_uuid?: string;
  node_run_uuid?: string;
  /** Round-tripped; agent-runner returns turn_count + 1 after a conversational turn. */
  turn_count?: number;
  /** "" = greeting turn (the node speaks first). */
  user_message?: string;
  /** Per-turn tool-mock override, merged over world_state[node].action_mocks. */
  action_mocks?: Record<string, unknown>;
  /** Opaque conversation context items, threaded back verbatim each turn. */
  context_items?: unknown[];
  variables_by_node?: Record<string, Record<string, unknown>>;
}

/** One walk segment agent-runner traversed: from a node, out a handle, through mocked `via`
 *  hops, to a landing node (`to_node_uuid` null on a terminal/abort). */
export interface SimTransition {
  from_node_uuid: string;
  handle: string;
  via: Array<{ node_uuid: string; type: string; outcome: string }>;
  to_node_uuid: string | null;
  to_type: string;
}

/** Response body — the agent-runner `SimResponse` (schema.py), stop_reason already mapped to
 *  the public walker vocabulary by handler.py. */
export interface SimResponse {
  message: string;
  intent: string;
  variables: Record<string, unknown>;
  tool_calls: unknown[];
  response_items: unknown[];
  /** The node that spoke this turn and fired `intent` — the transcript/judge key. */
  turn_node_uuid: string;
  /** The node AFTER the walk; thread into the next request only. */
  node_uuid: string;
  node_run_uuid: string;
  turn_count: number;
  /** "speech" (a normal turn) | "transition" (an empty-user greeting turn). */
  turn_type: string;
  transitions: SimTransition[];
  ended: boolean;
  /** "" | end_conversation | max_turns | unknown_intent | no_matching_edge | unsupported_node_type | error */
  stop_reason: string;
  stop_detail: string;
  context_items: unknown[];
  variables_by_node: Record<string, Record<string, unknown>>;
}

/** Abort stop reasons — the ones that mean the scenario could not reach a judged outcome, so
 *  their `stop_detail` is written to `ao_sim_run_scenario.error` (D5). `end_conversation` and
 *  `max_turns` are NOT here: their rows keep `error = null` so they still count toward
 *  passed/failed (extractGoalPassed stops counting a row once `error` is non-null). */
export const ABORT_STOP_REASONS: ReadonlySet<string> = new Set([
  "unknown_intent",
  "no_matching_edge",
  "unsupported_node_type",
  "error",
]);

export interface LiveKitSimClientOptions {
  /** Base URL; defaults to simEngineConfig.livekitSimTurnUrl (LIVEKIT_SIM_TURN_URL). */
  url?: string;
  /** Optional Basic-auth credentials (agent-runner is unauthenticated on the private network). */
  username?: string;
  password?: string;
  /** Per-request timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

/** Thrown on any request failure (unconfigured URL, timeout, non-200, or unparseable body). */
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
  /** Per-session cookie store (sessionId → "name=value; …"): task-unit flow-sessions are
   *  server-held, so every turn must carry the sticky LB cookie to reach the same container.
   *  Bun's fetch has no auto cookie jar, so Set-Cookie pairs are persisted + resent manually. */
  private readonly sessionCookies = new Map<string, string>();

  constructor(opts: LiveKitSimClientOptions = {}) {
    this.url = opts.url ?? simEngineConfig.livekitSimTurnUrl ?? "";
    this.username = opts.username ?? "";
    this.password = opts.password ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** One stateless agent turn (ai_agent_v2). `node_uuid: ""` on the first call resolves entry. */
  async turn(req: SimTurnRequest): Promise<SimResponse> {
    return this.postTurn(TURN_PATH, req);
  }

  /** Open a server-held task-unit session (screening / agent_node); the response carries the opener. */
  async flowSessionStart(req: SimTurnRequest): Promise<SimResponse> {
    return this.postTurn(FLOW_SESSION_START_PATH, req);
  }

  /** Drive one turn of a held task-unit session; the exit turn carries the disposition + landing node. */
  async flowSessionTurn(req: SimTurnRequest): Promise<SimResponse> {
    return this.postTurn(FLOW_SESSION_TURN_PATH, req);
  }

  /** Best-effort eviction of a held session (agent-runner also evicts on the exit turn + TTL). */
  async flowSessionEnd(sessionId: string): Promise<void> {
    if (!this.url || !sessionId) return;
    try {
      await this.rawPost(FLOW_SESSION_END_PATH, { simulation_session_id: sessionId }, sessionId);
    } catch {
      // Cleanup is advisory; TTL eviction covers the failure.
    }
  }

  /** Generator dry-run: reachable AI nodes, mockable-outcome handles, terminals, and the
   *  unsimulatable-node list AO refuses generation on. No LLM, same walker as the run path. */
  async inventory(flow: Record<string, unknown>, worldState?: Record<string, unknown>): Promise<FlowInventory> {
    const body = await this.rawPost(INVENTORY_PATH, { flow, world_state: worldState ?? {} }, "");
    return body as unknown as FlowInventory;
  }

  private authHeader(): Record<string, string> {
    if (!this.username && !this.password) return {};
    const token = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  /** Merge the response's Set-Cookie pairs into the per-session jar (name-keyed). */
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
      const first = (sc.split(";")[0] ?? "").trim();
      const eq = first.indexOf("=");
      if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
    this.sessionCookies.set(sessionId, [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  }

  /** Forget a session's cookie jar (session ids are fresh UUIDs per scenario). */
  forgetSession(sessionId: string): void {
    if (sessionId) this.sessionCookies.delete(sessionId);
  }

  private async postTurn(path: string, req: SimTurnRequest): Promise<SimResponse> {
    const body = await this.rawPost(path, req, req.simulation_session_id ?? "");
    return body as unknown as SimResponse;
  }

  private async rawPost(path: string, req: object, sessionId: string): Promise<Record<string, unknown>> {
    if (!this.url) throw new LiveKitSimError("livekit sim URL not configured");
    const url = `${this.url}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const cookieHeader = sessionId ? this.sessionCookies.get(sessionId) : undefined;

    // The timeout must cover the BODY read too, not just response headers: a server that sends
    // headers then stalls mid-body would otherwise hang this turn forever and wedge a worker slot.
    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeader(),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        // JSON.stringify drops undefined keys — the request carries exactly the set fields.
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      text = await resp.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LiveKitSimError(`livekit sim ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new LiveKitSimError(`livekit sim request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (sessionId) this.storeCookies(sessionId, resp);

    if (resp.status !== 200) {
      const preview = text.length > MAX_ERROR_PREVIEW ? text.slice(0, MAX_ERROR_PREVIEW) : text;
      throw new LiveKitSimError(`livekit sim ${path} returned status ${resp.status}: ${preview}`, resp.status);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new LiveKitSimError(`failed to decode response: ${(err as Error).message}`);
    }
  }
}

/** Factory: base URL from config, optional Basic creds via opts. */
export function makeLiveKitSimClient(opts: LiveKitSimClientOptions = {}): LiveKitSimClient {
  return new LiveKitSimClient(opts);
}
