import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalPayloadV0 } from "./types.js";

export interface UploadConfig {
  url: string;
  basicAuth?: { user: string; pass: string } | null;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * POST the payload to `{url}/observability/evals/v0`.
 * Returns true on success. Never throws.
 */
export async function upload(
  payload: EvalPayloadV0,
  config: UploadConfig,
  opts: { fallbackDir?: string | null; logger?: Logger } = {},
): Promise<boolean> {
  const { fallbackDir, logger = defaultLogger } = opts;
  const endpoint = `${stripTrailingSlash(config.url)}/observability/evals/v0`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.basicAuth) {
    const token = Buffer.from(
      `${config.basicAuth.user}:${config.basicAuth.pass}`,
      "utf8",
    ).toString("base64");
    headers["Authorization"] = `Basic ${token}`;
  }

  const body = JSON.stringify(payload);
  let lastErr = "";

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (res.ok) return true;
      // 4xx = permanent; stop retrying.
      if (res.status >= 400 && res.status < 500) {
        lastErr = `HTTP ${res.status}: ${await safeText(res)}`;
        break;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = `${(e as Error).name}: ${(e as Error).message}`;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < config.maxRetries) {
      await sleep(Math.min(2 ** (attempt - 1), 4) * 1000);
    }
  }

  logger.warn(
    `agent-observability upload failed after ${config.maxRetries} attempts: ${lastErr}`,
  );
  if (fallbackDir) await writeFallback(payload, fallbackDir, logger);
  return false;
}

async function writeFallback(
  payload: EvalPayloadV0,
  dir: string,
  logger: Logger,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const runId = payload.run?.run_id || "unknown";
    const p = path.join(dir, `${runId}.json`);
    await writeFile(p, JSON.stringify(payload, null, 2));
    logger.warn(`wrote eval payload to ${p}`);
  } catch (e) {
    logger.error(`failed to write fallback payload: ${(e as Error).message}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface Logger {
  info?(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const defaultLogger: Logger = {
  info: (m) => console.log(`[agent-observability] ${m}`),
  warn: (m) => console.warn(`[agent-observability] ${m}`),
  error: (m) => console.error(`[agent-observability] ${m}`),
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): UploadConfig | null {
  const url = env.AGENT_OBSERVABILITY_URL;
  if (!url) return null;
  const user = env.AGENT_OBSERVABILITY_USER;
  const pass = env.AGENT_OBSERVABILITY_PASS;
  return {
    url,
    basicAuth: user && pass ? { user, pass } : null,
    timeoutMs: 10_000,
    maxRetries: 3,
  };
}
