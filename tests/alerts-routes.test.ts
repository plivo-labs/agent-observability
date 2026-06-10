import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock side-effectful modules before importing the app ────────────────────

const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
mockSql.unsafe = mockSql;
mockSql.begin = (fn: (tx: any) => Promise<unknown>) => fn(mockSql);

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

mock.module("../src/config.js", () => ({
  config: {
    PORT: 9090,
    AGENT_OBSERVABILITY_USER: TEST_USER,
    AGENT_OBSERVABILITY_PASS: TEST_PASS,
    AUTO_MIGRATE: false,
    DATABASE_URL: "postgres://localhost:5432/test",
    S3_REGION: "us-east-1",
    S3_PREFIX: "recordings",
  },
  s3Enabled: false,
  basicAuthEnabled: true,
  liveKitAuthEnabled: false,
}));

mock.module("../src/db.js", () => ({
  sql: mockSql,
  insertSession: mock(() => Promise.resolve()),
  applyStoredSessionTags: mock(() => Promise.resolve()),
  upsertSessionTag: mock(() => Promise.resolve()),
  insertLiveKitEvaluation: mock(() => Promise.resolve()),
  upsertSessionOutcome: mock(() => Promise.resolve()),
  applySessionTagMetadata: mock(() => Promise.resolve()),
  mergeSessionRawReport: mock(() => Promise.resolve()),
}));

mock.module("../src/migrate.js", () => ({ migrate: () => Promise.resolve() }));
mock.module("../src/s3.js", () => ({ uploadRecording: () => Promise.resolve("") }));

const mockListAlertRules = mock(() => Promise.resolve({ rules: [] as any[], totalCount: 0 }));
const mockGetAlertRule = mock(() => Promise.resolve(null as any));
const mockInsertAlertRule = mock((input: any) =>
  Promise.resolve({ id: "11111111-1111-1111-1111-111111111111", ...input }),
);
const mockUpdateAlertRule = mock(() => Promise.resolve(null as any));
const mockDeleteAlertRule = mock(() => Promise.resolve(false));
const mockListFirings = mock(() => Promise.resolve({ firings: [] as any[], totalCount: 0 }));
const mockListWebhookAttempts = mock(() => Promise.resolve({ attempts: [] as any[], totalCount: 0 }));
const mockGetWebhookStats = mock(() =>
  Promise.resolve({
    total_attempts: 4,
    accepted: 3,
    acceptance_rate: 0.75,
    avg_duration_ms: 120,
    buckets: [],
    rule_breakdown: [],
  }),
);

mock.module("../src/alerts/db.js", () => ({
  listAlertRules: mockListAlertRules,
  getAlertRule: mockGetAlertRule,
  insertAlertRule: mockInsertAlertRule,
  updateAlertRule: mockUpdateAlertRule,
  deleteAlertRule: mockDeleteAlertRule,
  listFirings: mockListFirings,
  listWebhookAttempts: mockListWebhookAttempts,
  getWebhookStats: mockGetWebhookStats,
  insertWebhookAttempt: mock(() => Promise.resolve()),
  claimDueFirings: mock(() => Promise.resolve([])),
  markDelivered: mock(() => Promise.resolve()),
  markRetry: mock(() => Promise.resolve()),
  markFailed: mock(() => Promise.resolve()),
}));

// NOTE: alerts/{deliver,engine,sweeper}.js are deliberately NOT module-
// mocked — bun's module registry is shared across test files, and other
// suites exercise the real implementations. The test endpoint goes through
// the real deliverTest against a mocked global fetch instead. The sweeper
// never starts because bun test runs with NODE_ENV=test.

const { default: server } = await import("../src/index.js");

const RULE_ID = "22222222-2222-2222-2222-222222222222";

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:9090${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64")}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const validRule = {
  name: "fail spike",
  metric: "eval_fail_rate",
  judge_name: "task_completion",
  threshold_value: 0.3,
  min_samples: 10,
  window_minutes: 15,
  webhook_url: "https://hooks.example.com/alert",
  http_method: "PUT",
  headers: { "x-team": "voice" },
};

describe("alert rule routes", () => {
  beforeEach(() => {
    mockListAlertRules.mockClear();
    mockGetAlertRule.mockClear();
    mockInsertAlertRule.mockClear();
    mockUpdateAlertRule.mockClear();
    mockDeleteAlertRule.mockClear();
  });

  test("requires auth", async () => {
    const res = await server.fetch(new Request("http://localhost:9090/api/alert-rules"));
    expect(res.status).toBe(401);
  });

  test("creates a rule, keeping method/headers/threshold", async () => {
    const res = await server.fetch(
      authed("/api/alert-rules", { method: "POST", body: JSON.stringify(validRule) }),
    );
    expect(res.status).toBe(201);
    const input = (mockInsertAlertRule.mock.calls[0] as any[])[0];
    expect(input.metric).toBe("eval_fail_rate");
    expect(input.threshold_value).toBe(0.3);
    expect(input.http_method).toBe("PUT");
    expect(input.headers).toEqual({ "x-team": "voice" });
  });

  test.each([
    ["window below 15", { ...validRule, window_minutes: 5 }],
    ["missing metric", { ...validRule, metric: undefined }],
    ["unknown metric", { ...validRule, metric: "latency_unknown" }],
    ["missing threshold_value", { ...validRule, threshold_value: undefined }],
    ["rate threshold above 1", { ...validRule, threshold_value: 30 }],
    ["judge on a non-eval metric", { ...validRule, metric: "interruption_rate" }],
    ["non-http webhook", { ...validRule, webhook_url: "ftp://example.com/x" }],
    ["bad method", { ...validRule, http_method: "DELETE" }],
  ])("rejects invalid payload: %s", async (_label, payload) => {
    const res = await server.fetch(
      authed("/api/alert-rules", { method: "POST", body: JSON.stringify(payload) }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_payload");
  });

  test("latency metric rule rejects judge_name and accepts ms thresholds", async () => {
    const rejected = await server.fetch(
      authed("/api/alert-rules", {
        method: "POST",
        body: JSON.stringify({
          ...validRule,
          metric: "latency_tts_ttfb_p95",
          threshold_value: 800,
        }),
      }),
    );
    expect(rejected.status).toBe(400); // judge_name from validRule doesn't apply

    const accepted = await server.fetch(
      authed("/api/alert-rules", {
        method: "POST",
        body: JSON.stringify({
          ...validRule,
          metric: "latency_tts_ttfb_p95",
          judge_name: undefined,
          threshold_value: 800,
        }),
      }),
    );
    expect(accepted.status).toBe(201);
  });

  test("lists rules with pagination meta", async () => {
    mockListAlertRules.mockResolvedValueOnce({
      rules: [{ id: RULE_ID, name: "r" }] as any,
      totalCount: 1,
    });
    const res = await server.fetch(authed("/api/alert-rules?limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.total_count).toBe(1);
    expect(body.objects).toHaveLength(1);
  });

  test("404s on unknown or malformed rule ids", async () => {
    const malformed = await server.fetch(authed("/api/alert-rules/not-a-uuid"));
    expect(malformed.status).toBe(404);
    mockGetAlertRule.mockResolvedValueOnce(null);
    const missing = await server.fetch(authed(`/api/alert-rules/${RULE_ID}`));
    expect(missing.status).toBe(404);
  });

  // PATCH merge-validates against the stored rule, so getAlertRule must
  // return a create-schema-valid row.
  const storedRule = {
    id: RULE_ID,
    name: "existing",
    enabled: true,
    account_id: null,
    agent_id: null,
    metric: "eval_fail_rate",
    judge_name: null,
    threshold_value: 0.3,
    min_samples: 1,
    window_minutes: 15,
    webhook_url: "https://hooks.example.com/alert",
    http_method: "POST",
    secret: null,
    headers: null,
  };

  test("patches a rule", async () => {
    mockGetAlertRule.mockResolvedValueOnce(storedRule as any);
    mockUpdateAlertRule.mockResolvedValueOnce({ id: RULE_ID, name: "renamed" } as any);
    const res = await server.fetch(
      authed(`/api/alert-rules/${RULE_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "renamed", enabled: false }),
      }),
    );
    expect(res.status).toBe(200);
    const patch = (mockUpdateAlertRule.mock.calls[0] as any[])[1];
    expect(patch.name).toBe("renamed");
    expect(patch.enabled).toBe(false);
  });

  test("rejects a partial patch that breaks cross-field rules on the merged rule", async () => {
    // Stored rule is a rate metric; patching a bare fraction > 1 must fail
    // the merged validation even though the metric isn't in the patch.
    mockGetAlertRule.mockResolvedValueOnce({ ...storedRule, metric: "eval_fail_rate" } as any);
    const res = await server.fetch(
      authed(`/api/alert-rules/${RULE_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ threshold_value: 30 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("fractions");
  });

  test("deletes a rule", async () => {
    mockDeleteAlertRule.mockResolvedValueOnce(true);
    const res = await server.fetch(authed(`/api/alert-rules/${RULE_ID}`, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
  });

  test("lists firings for a rule", async () => {
    mockListFirings.mockResolvedValueOnce({
      firings: [{ id: "f-1", status: "delivered" }] as any,
      totalCount: 1,
    });
    const res = await server.fetch(authed(`/api/alert-rules/${RULE_ID}/firings`));
    expect(res.status).toBe(200);
    expect((await res.json()).objects[0].status).toBe("delivered");
  });

  test("returns webhook stats with acceptance rate", async () => {
    const res = await server.fetch(authed("/api/alerts/webhook-stats?range=24h"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.acceptance_rate).toBeCloseTo(0.75);
    expect(body.range).toBe("24h");
  });

  test("test endpoint fires a synchronous webhook via real deliverTest", async () => {
    mockGetAlertRule.mockResolvedValueOnce({
      id: RULE_ID,
      name: "r",
      metric: "eval_fail_rate",
      webhook_url: "https://hooks.example.com/test",
      http_method: "POST",
      secret: null,
      headers: null,
    } as any);
    const realFetch = globalThis.fetch;
    let sentUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      sentUrl = String(url);
      return new Response("ok", { status: 202 });
    }) as any;
    try {
      const res = await server.fetch(authed(`/api/alert-rules/${RULE_ID}/test`, { method: "POST" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.response_status).toBe(202);
      expect(sentUrl).toBe("https://hooks.example.com/test");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
