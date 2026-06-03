/**
 * Observability URL env resolution + soft validation.
 *
 * Mirrors the Python helper in `agent_observability.livekit.env`.
 */

export interface EnsureObservabilityUrlOptions {
  /**
   * Logger to emit info / warn lines on. Defaults to `console`.
   */
  logger?: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void };
}

/**
 * Resolve the observability upload URL — pure, no side effects.
 *
 * Returns `LIVEKIT_OBSERVABILITY_URL` if set, otherwise the
 * `AGENT_OBSERVABILITY_URL` fallback (the var name agent-transport uses),
 * otherwise `null`. Reads `process.env` but never mutates it and never
 * logs.
 *
 * Use this when you just want the value. Use {@link ensureObservabilityUrl}
 * when you also need the fallback mirrored into `LIVEKIT_OBSERVABILITY_URL`
 * for LiveKit's upload code.
 *
 * @returns The resolved URL, or `null` if neither env var was set.
 */
export function resolveObservabilityUrl(): string | null {
  return process.env.LIVEKIT_OBSERVABILITY_URL ?? process.env.AGENT_OBSERVABILITY_URL ?? null;
}

/**
 * Resolve the observability upload URL **and mirror the fallback**.
 *
 * Resolves the URL via {@link resolveObservabilityUrl}
 * (`LIVEKIT_OBSERVABILITY_URL` first, then the `AGENT_OBSERVABILITY_URL`
 * fallback agent-transport uses).
 *
 * Side effects:
 *
 * - **Mutates `process.env`**: when the value came from the
 *   `AGENT_OBSERVABILITY_URL` fallback, it is mirrored into
 *   `LIVEKIT_OBSERVABILITY_URL` so LiveKit's upload code picks it up on its
 *   next read. Call {@link resolveObservabilityUrl} instead if you want the
 *   value without touching the environment.
 * - Logs `info` with the resolved URL when present.
 * - Logs `warn` when the URL is unset (session report upload will no-op).
 *
 * @returns The resolved URL, or `null` if neither env var was set.
 */
export function ensureObservabilityUrl(
  options: EnsureObservabilityUrlOptions = {},
): string | null {
  const log = options.logger ?? console;

  const url = resolveObservabilityUrl();
  if (url && !process.env.LIVEKIT_OBSERVABILITY_URL) {
    // Value came from the AGENT_OBSERVABILITY_URL fallback — mirror it.
    process.env.LIVEKIT_OBSERVABILITY_URL = url;
  }

  if (url) {
    log.info(`agent-observability upload target: ${url}`);
  } else {
    log.warn(
      "neither LIVEKIT_OBSERVABILITY_URL nor AGENT_OBSERVABILITY_URL " +
        "is set; session report upload will be skipped",
    );
  }
  return url;
}
