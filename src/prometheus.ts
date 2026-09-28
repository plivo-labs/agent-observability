import { hostname } from "node:os";
import { Pushgateway, Registry } from "prom-client";
import { config } from "./config.js";

export const registry = new Registry();
export const metricsRegion = config.AWS_REGION || "unknown";

const JOB_NAME = "agent-observability";
const PUSH_INTERVAL_MS = config.PROMETHEUS_PUSH_INTERVAL_MS ?? 15_000;

// One group per process: `push` (PUT) replaces the whole group, so two
// processes sharing a key would overwrite each other's counters.
const groupings = () => ({
  env: config.APP_ENV || "unknown",
  region: metricsRegion,
  hostname: hostname(),
  worker_id: String(process.pid),
});

let gateway: Pushgateway<"text/plain; version=0.0.4; charset=utf-8"> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

async function pushOnce(): Promise<void> {
  if (!gateway || inFlight) return;
  inFlight = gateway
    .push({ jobName: JOB_NAME, groupings: groupings() })
    .then(() => {})
    .catch((e) => console.warn(`[prometheus] push failed: ${(e as Error).message}`))
    .finally(() => { inFlight = null; });
  await inFlight;
}

export function startMetricsPush(): void {
  const url = config.PROMETHEUS_PUSHGATEWAY_URL;
  if (!url || timer) return;
  gateway = new Pushgateway(url, { timeout: 10_000 }, registry);
  timer = setInterval(() => void pushOnce(), PUSH_INTERVAL_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  console.log(`[prometheus] pushing to ${url} every ${PUSH_INTERVAL_MS / 1000}s`);
}

/** Deletes this process's group so a stopped pod doesn't leave its last
 *  counter values on the gateway forever. */
export async function stopMetricsPush(): Promise<void> {
  if (!timer || !gateway) return;
  clearInterval(timer);
  timer = null;
  // An in-flight PUT landing after the DELETE would resurrect the group.
  if (inFlight) await inFlight;
  try {
    await gateway.delete({ jobName: JOB_NAME, groupings: groupings() });
  } catch (e) {
    console.warn(`[prometheus] group delete failed: ${(e as Error).message}`);
  }
  gateway = null;
}
