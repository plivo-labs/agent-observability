import { createHmac } from "node:crypto";
import type { AlertRuleRow, DueDelivery, WebhookAttemptInput } from "./db.js";
import { insertWebhookAttempt } from "./db.js";

// ── Webhook delivery ────────────────────────────────────────────────────────
//
// At-least-once contract: a crash mid-POST re-attempts on the next sweep.
// Retry schedule (after the initial attempt): 30s, 2m, 10m, 30m, 2h.

export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;
export const WEBHOOK_TIMEOUT_MS = 10_000;

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

interface WebhookRequest {
  url: string;
  method: string;
  secret: string | null;
  extraHeaders: Record<string, string> | null;
  body: string;
  idHeaders: Record<string, string>;
}

/** Audit-trail insert that never breaks a delivery — failures only log. */
async function recordAttempt(input: WebhookAttemptInput): Promise<void> {
  try {
    await insertWebhookAttempt(input);
  } catch (e) {
    console.error(`[alerts] attempt audit insert failed: ${(e as Error).message}`);
  }
}

async function sendWebhook(req: WebhookRequest): Promise<DeliveryResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(req.extraHeaders ?? {}),
    ...req.idHeaders,
  };
  if (req.secret) {
    headers["x-alert-signature"] =
      `sha256=${createHmac("sha256", req.secret).update(req.body).digest("hex")}`;
  }
  const started = performance.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      error: res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      error: (e as Error).message || "fetch failed",
      durationMs: Math.round(performance.now() - started),
    };
  }
}

export function buildFiringPayload(d: DueDelivery): string {
  return JSON.stringify({
    type: "alert.triggered",
    firing_id: d.id,
    rule: {
      id: d.rule_id,
      name: d.rule_name,
      metric: d.metric,
      judge_name: d.judge_name,
      threshold_value: d.threshold_value,
      window_minutes: d.window_minutes,
    },
    window: { start: d.window_start, end: d.window_end },
    matched_count: d.matched_count,
    total_count: d.total_count,
    observed_value: d.observed_value,
    agent_id: d.agent_id,
    account_id: d.account_id,
    sample_session_ids: d.sample_session_ids,
    fired_at: d.created_at,
  });
}

/** Deliver one due firing; records the attempt in alert_webhook_attempts. */
export async function deliverFiring(d: DueDelivery): Promise<DeliveryResult> {
  const result = await sendWebhook({
    url: d.webhook_url,
    method: d.http_method,
    secret: d.secret,
    extraHeaders: d.headers,
    body: buildFiringPayload(d),
    idHeaders: { "x-alert-firing-id": d.id, "x-alert-rule-id": d.rule_id },
  });
  await recordAttempt({
    ruleId: d.rule_id,
    firingId: d.id,
    kind: "firing",
    url: d.webhook_url,
    httpMethod: d.http_method,
    attemptNumber: d.attempt_count + 1,
    ok: result.ok,
    responseStatus: result.status,
    error: result.error,
    durationMs: result.durationMs,
  });
  return result;
}

/** Synchronous test send for POST /api/alert-rules/:id/test. */
export async function deliverTest(rule: AlertRuleRow): Promise<DeliveryResult> {
  const body = JSON.stringify({
    type: "alert.test",
    rule: { id: rule.id, name: rule.name, metric: rule.metric },
    fired_at: new Date().toISOString(),
  });
  const result = await sendWebhook({
    url: rule.webhook_url,
    method: rule.http_method,
    secret: rule.secret,
    extraHeaders: rule.headers,
    body,
    idHeaders: { "x-alert-rule-id": rule.id },
  });
  await recordAttempt({
    ruleId: rule.id,
    firingId: null,
    kind: "test",
    url: rule.webhook_url,
    httpMethod: rule.http_method,
    attemptNumber: 1,
    ok: result.ok,
    responseStatus: result.status,
    error: result.error,
    durationMs: result.durationMs,
  });
  return result;
}
