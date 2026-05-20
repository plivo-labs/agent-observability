/**
 * Per-session observability bootstrap for raw-LiveKit (Node) workers.
 *
 * Mirrors the Python helper in `agent_observability.livekit.tags`.
 *
 * The agent-observability v2 server pulls `agent_id` (mandatory) and
 * `account_id` (optional) out of the multipart session report by
 * scanning two locations:
 *
 *   1. The top-level `raw_report.agent_id` / `raw_report.account_id`.
 *   2. Each tag string in `raw_report.tags[]` looking for the prefix
 *      `"agent_id:"` / `"account_id:"`.
 *
 * `initObservability` emits the second form (atomic tags) plus an
 * `agent.session` wrapper tag that carries everything in metadata for
 * raw_report fidelity. It also fast-fails if the upload URL is unset —
 * there is no point continuing if the session report has nowhere to go.
 */

import { ensureObservabilityUrl } from "./env.js";

/**
 * Minimal duck-typed shape of LiveKit's tagger. Anything with an
 * `add(name, metadata?)` method satisfies it.
 */
export interface Tagger {
  add(name: string, options?: { metadata?: Record<string, unknown> }): void;
}

export interface InitObservabilityOptions {
  /**
   * Stable opaque agent identifier. Falls back to
   * `AGENT_OBSERVABILITY_AGENT_ID` when omitted. Required: the v2
   * server accepts uploads without an agent_id (it nulls the column
   * and waits for an OTLP tag to backfill), but without this helper
   * emitting the tag the backfill never lands and the session stays
   * unparented on the dashboard.
   */
  agentId?: string;
  /** Human-readable label (display only). Optional. */
  agentName?: string;
  /** Tenant / customer identifier. Optional. */
  accountId?: string;
  /** Short label like `"text"`, `"audio"`, `"sip"`. Optional. */
  transport?: string;
  /**
   * Extra key/value pairs to ride along on the wrapper `agent.session`
   * tag's metadata. No atomic tags are derived from these — they only
   * land in the raw_report for inspection.
   */
  extraMetadata?: Record<string, unknown>;
  /** Override the logger for the URL info / warn line. Defaults to `console`. */
  logger?: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void };
}

/**
 * Bootstrap agent-observability for the current LiveKit session.
 *
 * Does two things, atomically, in this order:
 *
 *   1. Resolves the upload URL via {@link ensureObservabilityUrl}. If
 *      neither `LIVEKIT_OBSERVABILITY_URL` nor
 *      `AGENT_OBSERVABILITY_URL` is set, throws `Error` — there is no
 *      point continuing if the session report has nowhere to go.
 *   2. Emits the tag bundle the v2 server's ingest path expects:
 *
 *      - `agent_id:<value>` (always)
 *      - `account_id:<value>` (when supplied)
 *      - `agent.name:<value>` (when supplied)
 *      - `transport:<value>` (when supplied)
 *      - `agent.session` (wrapper with everything in metadata)
 *
 * @returns The resolved `agent_id`.
 * @throws When the upload URL is unset or `agentId` cannot be resolved.
 */
export function initObservability(tagger: Tagger, options: InitObservabilityOptions = {}): string {
  if (ensureObservabilityUrl({ logger: options.logger }) === null) {
    throw new Error(
      "initObservability: no upload target. Set LIVEKIT_OBSERVABILITY_URL " +
        "(or AGENT_OBSERVABILITY_URL) before initializing. Use " +
        "ensureObservabilityUrl() directly if you want a non-fatal " +
        "warn-only contract.",
    );
  }

  const resolvedAgentId = options.agentId ?? process.env.AGENT_OBSERVABILITY_AGENT_ID ?? "";
  if (!resolvedAgentId) {
    throw new Error(
      "initObservability: agentId is required. Pass agentId='<uuid>' or " +
        "set AGENT_OBSERVABILITY_AGENT_ID. The server accepts uploads " +
        "without one, but the session will sit unparented on the " +
        "dashboard with no agent_id backfill ever arriving.",
    );
  }

  const metadata: Record<string, unknown> = { agent_id: resolvedAgentId };
  if (options.agentName) metadata.agent_name = options.agentName;
  if (options.accountId) metadata.account_id = options.accountId;
  if (options.transport) metadata.transport = options.transport;
  if (options.extraMetadata) Object.assign(metadata, options.extraMetadata);

  // Wrapper tag — carries everything in metadata for raw_report fidelity.
  tagger.add("agent.session", { metadata });

  // Atomic tags — what the server's extractors actually pattern-match on.
  tagger.add(`agent_id:${resolvedAgentId}`, { metadata: { agent_id: resolvedAgentId } });
  if (options.accountId) {
    tagger.add(`account_id:${options.accountId}`, { metadata: { account_id: options.accountId } });
  }
  if (options.agentName) {
    tagger.add(`agent.name:${options.agentName}`, { metadata: { agent_name: options.agentName } });
  }
  if (options.transport) {
    tagger.add(`transport:${options.transport}`, { metadata: { transport: options.transport } });
  }

  return resolvedAgentId;
}
