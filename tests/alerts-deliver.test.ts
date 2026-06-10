import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";

const mockInsertWebhookAttempt = mock(() => Promise.resolve());

mock.module("../src/alerts/db.js", () => ({
  insertWebhookAttempt: mockInsertWebhookAttempt,
}));

const { deliverFiring, deliverTest, buildFiringPayload, RETRY_BACKOFF_MS, MAX_ATTEMPTS } =
  await import("../src/alerts/deliver.js");

const baseDue: any = {
  id: "f1f1f1f1-0000-0000-0000-000000000001",
  rule_id: "r1r1r1r1-0000-0000-0000-000000000001",
  rule_name: "fail spike",
  metric: "eval_fail_rate",
  judge_name: "task_completion",
  threshold_value: 0.2,
  window_minutes: 15,
  agent_id: "agent-a",
  account_id: "acct-1",
  webhook_url: "https://hooks.example.com/alert",
  http_method: "POST",
  secret: null,
  headers: null,
  window_start: "2026-06-10T10:00:00Z",
  window_end: "2026-06-10T10:15:00Z",
  matched_count: 4,
  total_count: 10,
  observed_value: 0.4,
  sample_session_ids: ["s-1", "s-2"],
  status: "pending",
  attempt_count: 0,
  created_at: "2026-06-10T10:15:01Z",
};

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

function mockFetch(status: number) {
  globalThis.fetch = mock(async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("ok", { status });
  }) as any;
}

describe("alerts/deliver", () => {
  beforeEach(() => {
    fetchCalls = [];
    mockInsertWebhookAttempt.mockClear();
  });

  test("2xx delivery is ok and records an audit row", async () => {
    mockFetch(204);
    const result = await deliverFiring(baseDue);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.error).toBeNull();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://hooks.example.com/alert");
    expect(fetchCalls[0].init.method).toBe("POST");
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-alert-firing-id"]).toBe(baseDue.id);
    expect(headers["x-alert-rule-id"]).toBe(baseDue.rule_id);
    expect(headers["x-alert-signature"]).toBeUndefined();

    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.type).toBe("alert.triggered");
    expect(body.matched_count).toBe(4);
    expect(body.observed_value).toBe(0.4);
    expect(body.rule.window_minutes).toBe(15);
    expect(body.sample_session_ids).toEqual(["s-1", "s-2"]);

    expect(mockInsertWebhookAttempt).toHaveBeenCalledTimes(1);
    const attempt = (mockInsertWebhookAttempt.mock.calls[0] as any)[0];
    expect(attempt.kind).toBe("firing");
    expect(attempt.ok).toBe(true);
    expect(attempt.attemptNumber).toBe(1);
  });

  test("signs the exact body with HMAC-SHA256 when a secret is set", async () => {
    mockFetch(200);
    await deliverFiring({ ...baseDue, secret: "s3cret" });
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    const body = String(fetchCalls[0].init.body);
    const expected = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(headers["x-alert-signature"]).toBe(expected);
  });

  test("merges custom headers and honors the configured method", async () => {
    mockFetch(200);
    await deliverFiring({
      ...baseDue,
      http_method: "PUT",
      headers: { "x-team": "voice", authorization: "Bearer tok" },
    });
    expect(fetchCalls[0].init.method).toBe("PUT");
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["x-team"]).toBe("voice");
    expect(headers["authorization"]).toBe("Bearer tok");
  });

  test("non-2xx is a failure with the status captured", async () => {
    mockFetch(503);
    const result = await deliverFiring({ ...baseDue, attempt_count: 2 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBe("HTTP 503");
    const attempt = (mockInsertWebhookAttempt.mock.calls[0] as any)[0];
    expect(attempt.ok).toBe(false);
    expect(attempt.attemptNumber).toBe(3);
  });

  test("network error is a failure with null status", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as any;
    const result = await deliverFiring(baseDue);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("test sends audit with kind=test and no firing id", async () => {
    mockFetch(200);
    const rule: any = {
      id: baseDue.rule_id,
      name: "fail spike",
      metric: "eval_fail_rate",
      webhook_url: "https://hooks.example.com/alert",
      http_method: "POST",
      secret: null,
      headers: null,
    };
    const result = await deliverTest(rule);
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.type).toBe("alert.test");
    const attempt = (mockInsertWebhookAttempt.mock.calls[0] as any)[0];
    expect(attempt.kind).toBe("test");
    expect(attempt.firingId).toBeNull();
  });

  test("retry schedule constants are consistent", () => {
    expect(MAX_ATTEMPTS).toBe(RETRY_BACKOFF_MS.length + 1);
    expect(RETRY_BACKOFF_MS[0]).toBe(30_000);
    expect(buildFiringPayload(baseDue)).toContain('"alert.triggered"');
  });
});
