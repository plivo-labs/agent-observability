// AO Simulation Engine — agent-runner simulation client.
//
// agent-runner owns the run: the flow walk (entry, edge resolution, branch evaluation, non-AI
// node execution), node identity, span switching, turn counting and all conversation state. AO
// holds one run per scenario (keyed by phlo_run_uuid) and drives three surfaces:
//   - turn()       POST /v1/simulation/turn            (one conversation turn; "" user_message = greeting)
//   - end()        POST /v1/simulation/end             (best-effort early teardown on error/cancel)
//   - inventory()  POST /v1/simulation/flow/inventory  (generator dry-run, no LLM)
//
// Request bodies are byte-for-byte the agent-runner `SimTurnRequest` (extra="forbid", so every
// key must exist there); the timeout covers the body read. A 410 means the run's owning replica
// is gone — mapped to LiveKitSimError.runLost so the caller ends the scenario with a run_lost detail.

import { simEngineConfig } from "../config.js";
import type { FlowInventory } from "../gen/inventory.js";

const TURN_PATH = "/v1/simulation/turn";
const END_PATH = "/v1/simulation/end";
const INVENTORY_PATH = "/v1/simulation/flow/inventory";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_PREVIEW = 500;

/** Request body for /turn — the agent-runner `SimTurnRequest` (schema.py). `extra="forbid"` on
 *  the server, so no key outside this set may ever be sent; agent-runner owns node identity, turn
 *  counting and all conversation state, so AO threads none of it back. */
export interface SimTurnRequest {
  phlo_run_uuid: string;
  auth_id: string;
  /** "" = greeting turn (the agent speaks first). */
  user_message?: string;
  /** Canonical FLOW_JSON (Shape B). Resent every turn; agent-runner caches the parse by sha256. */
  flow: Record<string, unknown>;
  /** {node_id | config_name: {outcome?, data?, action_mocks?}} — pins mocked outcomes + seeds vars. */
  world_state?: Record<string, unknown>;
  /** Seeded under the trigger's prod namespace on the entry walk. */
  start_node_params?: Record<string, unknown>;
  max_turns: number;
  /** Per-turn tool-mock override; omitted by AO (agent-runner reads world_state[node].action_mocks). */
  action_mocks?: Record<string, unknown>;
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
  /** The node AFTER the walk (agent-runner's own state; AO reads it only as a transcript fallback). */
  node_uuid: string;
  node_run_uuid: string;
  turn_count: number;
  /** "speech" (a normal turn) | "transition" (an empty-user greeting turn). */
  turn_type: string;
  transitions: SimTransition[];
  ended: boolean;
  /** "" until the flow terminates, then the public walker vocabulary (StopReason). */
  stop_reason: StopReason | "";
  stop_detail: string;
  variables_by_node: Record<string, Record<string, unknown>>;
  /** Who speaks the next turn: "agent" ⇒ AO sends an empty user_message so the landed node opens. */
  next_speaker: "agent" | "caller";
}

/** Stop reasons AO persists to `ao_sim_run_scenario.stop_reason`. The first six are the wire
 *  vocabulary agent-runner emits; `caller_goal_met` / `caller_hung_up` are
 *  AO assertion-layer verdicts set locally (the caller decided to end, or the run took the wrong
 *  route) — agent-runner never emits them, and they are deliberately NOT abort reasons. */
export type StopReason =
  | "end_conversation"
  | "max_turns"
  | "unknown_intent"
  | "no_matching_edge"
  | "unsupported_node_type"
  | "error"
  | "caller_goal_met"
  | "caller_hung_up";

/** Abort stop reasons — the ones that mean the scenario could not reach a judged outcome, so
 *  their `stop_detail` is written to `ao_sim_run_scenario.error`. `end_conversation` and
 *  `max_turns` are NOT here: their rows keep `error = null` so they still count toward
 *  passed/failed (extractGoalPassed stops counting a row once `error` is non-null). */
export const ABORT_STOP_REASONS: ReadonlySet<StopReason> = new Set<StopReason>([
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

/** Thrown on any request failure (unconfigured URL, timeout, non-200, or unparseable body).
 *  `runLost` is set on a 410: the run's owning replica is gone, so the scenario is unrecoverable. */
export class LiveKitSimError extends Error {
  readonly status?: number;
  readonly runLost: boolean;
  constructor(message: string, status?: number, runLost = false) {
    super(message);
    this.name = "LiveKitSimError";
    this.status = status;
    this.runLost = runLost;
  }
}

export class LiveKitSimClient {
  private readonly url: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LiveKitSimClientOptions = {}) {
    this.url = opts.url ?? simEngineConfig.livekitSimTurnUrl ?? "";
    this.username = opts.username ?? "";
    this.password = opts.password ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** One conversation turn against the held run. `user_message: ""` (or absent) draws a greeting. */
  async turn(req: SimTurnRequest): Promise<SimResponse> {
    const body = await this.rawPost(TURN_PATH, req);
    return body as unknown as SimResponse;
  }

  /** Best-effort early teardown of a run (agent-runner also evicts on `ended` + TTL). */
  async end(phloRunUuid: string): Promise<void> {
    if (!this.url || !phloRunUuid) return;
    try {
      await this.rawPost(END_PATH, { phlo_run_uuid: phloRunUuid });
    } catch (err) {
      // Cleanup is advisory (TTL eviction covers it); log so a leak is traceable.
      console.warn(`[sim] end failed for ${phloRunUuid}: ${(err as Error).message}`);
    }
  }

  /** Generator dry-run: reachable AI nodes, mockable-outcome handles, terminals, and the
   *  unsimulatable-node list AO refuses generation on. No LLM, same walker as the run path. */
  async inventory(flow: Record<string, unknown>, worldState?: Record<string, unknown>): Promise<FlowInventory> {
    const body = await this.rawPost(INVENTORY_PATH, { flow, world_state: worldState ?? {} });
    return body as unknown as FlowInventory;
  }

  private authHeader(): Record<string, string> {
    if (!this.username && !this.password) return {};
    const token = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  private async rawPost(path: string, req: object): Promise<Record<string, unknown>> {
    if (!this.url) throw new LiveKitSimError("livekit sim URL not configured");
    const url = `${this.url}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // The timeout must cover the BODY read too, not just response headers: a server that sends
    // headers then stalls mid-body would otherwise hang this turn forever and wedge a worker slot.
    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeader() },
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

    if (resp.status !== 200) {
      const preview = text.length > MAX_ERROR_PREVIEW ? text.slice(0, MAX_ERROR_PREVIEW) : text;
      throw new LiveKitSimError(
        `livekit sim ${path} returned status ${resp.status}: ${preview}`,
        resp.status,
        resp.status === 410,
      );
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
