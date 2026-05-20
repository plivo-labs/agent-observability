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
 * Resolve the observability upload URL the LiveKit SDK reads.
 *
 * Reads `LIVEKIT_OBSERVABILITY_URL`. When unset, falls back to
 * `AGENT_OBSERVABILITY_URL` (the var name agent-transport uses); the
 * fallback value is mirrored back into `LIVEKIT_OBSERVABILITY_URL` so
 * LiveKit's upload code picks it up on its next read.
 *
 * Side effects:
 *
 * - Logs `info` with the resolved URL when present.
 * - Logs `warn` when the URL is unset (session report upload will no-op).
 *
 * @returns The resolved URL, or `null` if neither env var was set.
 */
export function ensureObservabilityUrl(
  options: EnsureObservabilityUrlOptions = {},
): string | null {
  const log = options.logger ?? console;

  let url = process.env.LIVEKIT_OBSERVABILITY_URL ?? null;
  if (!url) {
    const fallback = process.env.AGENT_OBSERVABILITY_URL;
    if (fallback) {
      process.env.LIVEKIT_OBSERVABILITY_URL = fallback;
      url = fallback;
    }
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
