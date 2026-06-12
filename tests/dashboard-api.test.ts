/**
 * Dashboard API endpoint tests (GET/DELETE /api/sessions, session detail,
 * analytics stats) against the mocked db. Split out of routes.test.ts to
 * keep that file focused on the ingest surface; the shared mock preamble
 * lives in test-app.ts.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { registerAppMocks, server, mockSql, basicAuthHeader, makeRequest } from "./test-app.js";

registerAppMocks();

describe("GET /api/sessions", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  test("rejects request without auth", async () => {
    const res = await server.fetch(makeRequest("/api/sessions"));
    expect(res.status).toBe(401);
  });

  test("returns paginated sessions list", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([
        { id: 1, session_id: "sess-1", turn_count: 3, created_at: "2025-01-01" },
        { id: 2, session_id: "sess-2", turn_count: 5, created_at: "2025-01-02" },
      ]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=10&offset=0", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.meta.total_count).toBe(2);
    expect(body.objects).toHaveLength(2);
    expect(body.meta.limit).toBe(10);
    expect(body.meta.offset).toBe(0);
    expect(body.meta.next).toBeNull();
    expect(body.meta.previous).toBeNull();
  });

  test("applies default pagination", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.offset).toBe(0);
    expect(body.meta.limit).toBe(20);
  });

  test("clamps limit to 50", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=999", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.limit).toBe(50);
  });

  test("clamps offset minimum to 0", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?offset=-5", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.offset).toBe(0);
  });

  test("includes next/previous pagination links", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 30 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=10&offset=10", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.next).toContain("offset=20");
    expect(body.meta.previous).toContain("offset=0");
  });

  test("passes account_id filter as a case-insensitive LIKE predicate", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?account_id=Acct-XYZ", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    // Count + rows = 2 SQL calls; both must include the WHERE clause and the param.
    expect(mockSql).toHaveBeenCalledTimes(2);
    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).toContain("WHERE LOWER(account_id) LIKE");
    expect(countParams).toEqual(["%acct-xyz%"]);
    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(rowsQuery).toContain("WHERE LOWER(account_id) LIKE");
    expect(rowsParams).toEqual(["%acct-xyz%", 20, 0]);
  });

  test("escapes LIKE metacharacters in account_id input", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?account_id=" + encodeURIComponent("50% off_lab"), {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    // `%` and `_` are escaped, lower-cased, then wrapped in `%...%`.
    expect(countParams).toEqual(["%50\\% off\\_lab%"]);
  });

  test("passes q as a websearch transcript predicate on count and rows", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?q=" + encodeURIComponent("cancel my subscription"), {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    expect(mockSql).toHaveBeenCalledTimes(2);
    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    // Must match the migration's index expression verbatim, bound raw (no
    // LIKE escaping — websearch_to_tsquery tolerates any input).
    expect(countQuery).toContain(
      "to_tsvector('english', transcript_text) @@ websearch_to_tsquery('english', $1)"
    );
    expect(countParams).toEqual(["cancel my subscription"]);
    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(rowsQuery).toContain(
      "to_tsvector('english', transcript_text) @@ websearch_to_tsquery('english', $1)"
    );
    expect(rowsParams).toEqual([
      "cancel my subscription",
      20,
      0,
      'StartSel=\u0001, StopSel=\u0002, MaxFragments=2, MaxWords=12, MinWords=6, FragmentDelimiter=" … "',
    ]);
  });

  test("ignores blank q", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?q=" + encodeURIComponent("   "), {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).not.toContain("websearch_to_tsquery");
    expect(countParams).toEqual([]);
  });

  test("carries q through pagination links", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 30 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=10&offset=10&q=refund", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.next).toContain("q=refund");
    expect(body.meta.previous).toContain("q=refund");
  });

  test("selects a ts_headline match_snippet on rows when q is active", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?q=refund", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    // The count query never pays for headline generation.
    const [countQuery] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).not.toContain("ts_headline");

    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    // $1 is the q param (the q predicate is always pushed first); the
    // options string rides as the last param, after LIMIT/OFFSET.
    expect(rowsQuery).toContain(
      "ts_headline('english', transcript_text, websearch_to_tsquery('english', $1), $4) AS match_snippet"
    );
    expect(rowsParams).toEqual([
      "refund",
      20,
      0,
      'StartSel=\u0001, StopSel=\u0002, MaxFragments=2, MaxWords=12, MinWords=6, FragmentDelimiter=" … "',
    ]);
  });

  test("keeps snippet param numbering correct alongside other filters", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?q=refund&agent_id=agent-1", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    // params: $1=q, $2=agent_id, $3=limit, $4=offset, $5=headline options
    expect(rowsQuery).toContain(
      "ts_headline('english', transcript_text, websearch_to_tsquery('english', $1), $5) AS match_snippet"
    );
    expect(rowsQuery).toContain("LIMIT $3 OFFSET $4");
    expect(rowsParams).toHaveLength(5);
  });

  test("omits match_snippet entirely without q", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(rowsQuery).not.toContain("ts_headline");
    expect(rowsParams).toEqual([20, 0]);
  });

  test("passes started_from/started_to filters as timestamp predicates", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const from = "2026-04-01T00:00:00.000Z";
    const to = "2026-04-30T23:59:59.999Z";
    const res = await server.fetch(
      makeRequest(`/api/sessions?started_from=${encodeURIComponent(from)}&started_to=${encodeURIComponent(to)}`, {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    expect(mockSql).toHaveBeenCalledTimes(2);
    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).toContain("started_at >=");
    expect(countQuery).toContain("started_at <=");
    expect(countParams).toEqual([from, to]);
  });

  test("combines account_id + date range into a single WHERE clause", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const from = "2026-04-01T00:00:00.000Z";
    const to = "2026-04-30T23:59:59.999Z";
    const res = await server.fetch(
      makeRequest(
        `/api/sessions?account_id=acct-1&started_from=${encodeURIComponent(from)}&started_to=${encodeURIComponent(to)}`,
        { headers: { Authorization: basicAuthHeader() } },
      )
    );
    expect(res.status).toBe(200);

    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    // All three predicates present, joined with AND.
    expect(countQuery).toMatch(/LOWER\(account_id\) LIKE \$1.*AND.*started_at >= \$2.*AND.*started_at <= \$3/s);
    expect(countParams).toEqual(["%acct-1%", from, to]);
  });

  test("omits WHERE clause entirely when no filters are active", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [countQuery, countParams] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).not.toContain("WHERE");
    expect(countParams).toEqual([]);
  });

  test("pagination links preserve active filters", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 30 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?limit=10&offset=10&account_id=acct-1&started_from=2026-04-01", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.next).toContain("account_id=acct-1");
    expect(body.meta.next).toContain("started_from=2026-04-01");
    expect(body.meta.next).toContain("offset=20");
    expect(body.meta.previous).toContain("account_id=acct-1");
    expect(body.meta.previous).toContain("offset=0");
  });
});

// ── Dashboard API: GET /api/sessions/:id ────────────────────────────────────

describe("GET /api/sessions/:id", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  test("returns session detail with computed metrics", async () => {
    const chatHistory = [
      { id: "u1", type: "message", role: "user", content: "hi", metrics: { transcription_delay: 0.1 } },
      { id: "a1", type: "message", role: "assistant", content: "hello", metrics: { llm_node_ttft: 0.3, tts_node_ttfb: 0.05 } },
    ];
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-1",
        turn_count: 1,
        chat_history: JSON.stringify(chatHistory),
        session_metrics: JSON.stringify({ per_turn: [], usage: null }),
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-1", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.session_id).toBe("sess-1");
    expect(body.chat_history).toBeInstanceOf(Array);
    expect(body.session_metrics).toBeDefined();
    expect(body.session_metrics.turns).toHaveLength(1);
    expect(body.session_metrics.turns[0].llm_ttft_ms).toBe(300);
    expect(body.session_metrics.summary.total_turns).toBe(1);
  });

  test("returns native session evaluation data", async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          id: 1,
          session_id: "sess-eval",
          turn_count: 0,
          chat_history: [],
          session_metrics: { per_turn: [], usage: null },
        },
      ])
      .mockResolvedValueOnce([
        {
          name: "agent.session",
          metadata: JSON.stringify({ account_id: "acct-1", transport: "sip" }),
          source: "livekit_otlp",
          observed_at: "2026-04-14T10:03:47Z",
          created_at: "2026-04-14T10:03:47Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          source: "livekit_otlp",
          judge_name: "resolution_quality",
          tag: "agent.session",
          verdict: "pass",
          reasoning: "Resolved",
          instructions: "Resolve the user request",
          observed_at: "2026-04-14T10:03:48Z",
          raw: JSON.stringify({ score: 0.92 }),
          created_at: "2026-04-14T10:03:48Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          source: "livekit_otlp",
          outcome: "success",
          reason: "All judges passed",
          observed_at: "2026-04-14T10:03:49Z",
          raw: JSON.stringify({ outcome: "success" }),
          created_at: "2026-04-14T10:03:49Z",
        },
      ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-eval", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0].metadata.account_id).toBe("acct-1");
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0].judge_name).toBe("resolution_quality");
    expect(body.evaluations[0].raw.score).toBe(0.92);
    expect(body.outcome.outcome).toBe("success");
    expect(body.outcome.raw.outcome).toBe("success");
  });

  test("sorts session events by created_at", async () => {
    const chatHistory = [
      { id: "u1", type: "message", role: "user", content: "hi", metrics: {} },
    ];
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-events",
        turn_count: 1,
        chat_history: JSON.stringify(chatHistory),
        session_metrics: JSON.stringify({ per_turn: [], usage: null }),
        raw_report: JSON.stringify({
          events: [
            { type: "late", created_at: 3 },
            { type: "untimed" },
            { type: "early", created_at: 1 },
            { type: "middle", created_at: "1970-01-01T00:00:02Z" },
          ],
          options: {},
        }),
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-events", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((event: any) => event.type)).toEqual([
      "early",
      "middle",
      "late",
      "untimed",
    ]);
  });

  test("normalizes legacy stringified raw_report arrays for events and options", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-legacy-raw",
        turn_count: 0,
        chat_history: [],
        session_metrics: JSON.stringify({ per_turn: [], usage: null }),
        raw_report: [
          {},
          JSON.stringify({
            options: { max_tool_steps: 3 },
            tags: ["account_id:acct-raw"],
          }),
          {
            events: [
              JSON.stringify([
                { type: "late", created_at: 3 },
                { type: "early", created_at: 1 },
                {
                  type: "conversation_item_added",
                  created_at: 2,
                  item: {
                    function_call: {
                      name: "lookup_order",
                      arguments: "{\"order_id\":\"1003\"}",
                    },
                  },
                },
              ]),
            ],
          },
        ],
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-legacy-raw", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options).toEqual({ max_tool_steps: 3 });
    expect(body.events.map((event: any) => event.type)).toEqual([
      "early",
      "conversation_item_added",
      "late",
    ]);
    expect(body.events[1].item).toEqual({
      name: "lookup_order",
      arguments: "{\"order_id\":\"1003\"}",
      type: "function_call",
    });
    expect(body.raw_report.tags).toEqual(["account_id:acct-raw"]);
  });

  test("handles already-parsed JSONB fields", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        session_id: "sess-2",
        turn_count: 0,
        chat_history: [{ id: "m1" }],
        session_metrics: { per_turn: [], usage: null },
      },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions/sess-2", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chat_history).toBeInstanceOf(Array);
  });

  test("returns 404 for non-existent session", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions/not-found", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("Session not found");
  });
});

// ── Dashboard API: DELETE /api/sessions ─────────────────────────────────────

describe("DELETE /api/sessions", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  test("rejects without auth", async () => {
    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["a"] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("400 when body is not JSON", async () => {
    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  test("400 when session_ids is missing or empty", async () => {
    const cases: Array<unknown> = [
      undefined,
      [],
      ["", "valid"],
      [123],
    ];
    for (const ids of cases) {
      const res = await server.fetch(
        makeRequest("/api/sessions", {
          method: "DELETE",
          headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
          body: JSON.stringify({ session_ids: ids }),
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_payload");
    }
  });

  test("400 when more than 200 ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `s-${i}`);
    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ids }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("too_many");
  });

  test("returns deleted count from RETURNING rows", async () => {
    mockSql.mockResolvedValueOnce([
      { session_id: "sess-1" },
      { session_id: "sess-2" },
    ]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        method: "DELETE",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["sess-1", "sess-2", "sess-missing"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(2);
    expect(body.api_id).toBeDefined();
  });
});

// ── Fleet analytics stats ────────────────────────────────────────────────────

describe("GET /api/analytics/stats", () => {
  beforeEach(() => {
    mockSql.mockClear();
    // mockResolvedValueOnce drops the base implementation once its queue
    // drains — restore the resolve-empty default for unqueued queries.
    mockSql.mockImplementation((..._args: any[]) => Promise.resolve([]));
  });

  test("requires auth", async () => {
    const res = await server.fetch(makeRequest("/api/analytics/stats"));
    expect(res.status).toBe(401);
  });

  test("returns fleet stats with computed rates", async () => {
    // Queries start in call order: stats-core buckets, stats-core totals,
    // fleet extras, interruption buckets, agent breakdown, account breakdown.
    mockSql.mockResolvedValueOnce([
      {
        bucket_start: "2026-06-10T00:00:00Z",
        session_count: 4,
        avg_duration_ms: 30000,
        estimated_cost_usd: "0.5",
        p95_user_perceived_ms: 1200,
      },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        total_sessions: 4,
        total_estimated_cost_usd: "0.5",
        avg_duration_ms: 30000,
        avg_turn_count: "3.5",
        p50_user_perceived_ms: 800,
        p95_user_perceived_ms: 1200,
        p99_user_perceived_ms: 1500,
        llm_pass_rate: "0.75",
        ci_pass_rate: null,
      },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        active_agents: 2,
        assistant_turns: 10,
        interrupted_turns: 2,
        outcome_success_rate: "0.5",
      },
    ]);
    mockSql.mockResolvedValueOnce([
      { bucket_start: "2026-06-10T00:00:00Z", assistant_turns: 10, interrupted_turns: 2 },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        agent_id: "agent-a",
        agent_name: "Support Bot",
        session_count: 3,
        avg_duration_ms: 20000,
        estimated_cost_usd: "0.3",
        p95_user_perceived_ms: 1000,
        assistant_turns: 8,
        interrupted_turns: 2,
        outcome_total: 2,
        outcome_success: 1,
      },
    ]);
    mockSql.mockResolvedValueOnce([
      { account_id: "acct-1", session_count: 4, estimated_cost_usd: "0.5" },
    ]);

    const res = await server.fetch(
      makeRequest("/api/analytics/stats?range=7d", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_id).toBeDefined();
    expect(body.range).toBe("7d");
    expect(body.total_sessions).toBe(4);
    expect(body.active_agents).toBe(2);
    expect(body.interruption_rate).toBeCloseTo(0.2);
    expect(body.llm_pass_rate).toBeCloseTo(0.75);
    expect(body.outcome_success_rate).toBeCloseTo(0.5);
    expect(body.ci_pass_rate).toBeNull();
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].interruption_rate).toBeCloseTo(0.2);
    expect(body.buckets[0].estimated_cost_usd).toBeCloseTo(0.5);
    expect(body.agent_breakdown).toHaveLength(1);
    expect(body.agent_breakdown[0].interruption_rate).toBeCloseTo(0.25);
    expect(body.agent_breakdown[0].outcome_success_rate).toBeCloseTo(0.5);
    expect(body.account_breakdown[0].account_id).toBe("acct-1");
  });

  test("clamps unknown range to the default", async () => {
    const res = await server.fetch(
      makeRequest("/api/analytics/stats?range=bogus", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe("7d");
    // Stats-core bucket query params: [agentId, interval, bucket, accountId].
    const firstCallParams = mockSql.mock.calls[0][1];
    expect(firstCallParams[0]).toBeNull(); // fleet-wide: no agent filter
    expect(firstCallParams[1]).toBe("7 days");
  });

  test("passes account_id through to every query", async () => {
    const res = await server.fetch(
      makeRequest("/api/analytics/stats?range=24h&account_id=acct-9", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account_id).toBe("acct-9");
    for (const call of mockSql.mock.calls) {
      expect(call[1]).toContain("acct-9");
    }
  });

  test("returns structured 500 when a query fails", async () => {
    mockSql.mockRejectedValueOnce(new Error("boom"));
    const res = await server.fetch(
      makeRequest("/api/analytics/stats", {
        headers: { Authorization: basicAuthHeader() },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("stats_failed");
  });
});
