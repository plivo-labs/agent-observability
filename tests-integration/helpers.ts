/**
 * Shared scaffolding for the integration suites. Both files run in ONE
 * bun process against the real DB — never close the shared sql pool from
 * a suite's afterAll; the other suite still needs it.
 */
import { describe } from "bun:test";
import { sql } from "../src/db.js";
import { insertAlertRule, type AlertRuleRow } from "../src/alerts/db.js";
import type { AlertRuleCreate } from "../src/alerts/schema.js";

let dbUp = true;
try {
  await sql`SELECT 1`;
} catch {
  dbUp = false;
  console.warn("[integration] DATABASE_URL unreachable — skipping integration suites");
}

/** `describeDb` skips the whole suite when no database is reachable. */
export const describeDb = dbUp ? describe : describe.skip;

const RULE_DEFAULTS: AlertRuleCreate = {
  name: "integration rule",
  enabled: true,
  account_id: null,
  agent_id: null,
  metric: "eval_fail_rate",
  judge_name: null,
  threshold_value: 0.5,
  min_samples: 1,
  window_minutes: 15,
  webhook_url: "http://localhost:1/never-delivered",
  http_method: "POST",
  secret: null,
  headers: null,
};

export interface TestRun {
  run: string;
  uid: (tag: string) => string;
  seedSession: (opts: {
    accountId: string;
    chatHistory?: unknown[];
    perTurn?: Array<Record<string, unknown>>;
  }) => Promise<string>;
  seedEval: (sessionId: string, verdict: string, judge?: string) => Promise<void>;
  seedOutcome: (sessionId: string, outcome: string) => Promise<void>;
  createRule: (over: Partial<AlertRuleCreate>) => Promise<AlertRuleRow>;
  firingsFor: (ruleId: string) => Promise<any[]>;
  cleanup: () => Promise<void>;
}

/** Per-suite namespace: every row this run creates carries the tag, and
 *  cleanup() removes exactly those rows (rules cascade to firings/attempts). */
export function testRun(prefix: string): TestRun {
  const run = `${prefix}-${Date.now().toString(36)}`;
  let seq = 0;
  const uid = (tag: string) => `${run}-${tag}-${++seq}`;

  return {
    run,
    uid,
    async seedSession(opts) {
      const sessionId = uid("sess");
      await sql`
        INSERT INTO agent_transport_sessions (
          session_id, account_id, started_at, ended_at, duration_ms, turn_count,
          chat_history, session_metrics
        ) VALUES (
          ${sessionId}, ${opts.accountId}, NOW() - interval '2 minutes', NOW(), 120000, 1,
          ${opts.chatHistory ?? []}::jsonb,
          ${{ per_turn: opts.perTurn ?? [] }}::jsonb
        )
      `;
      return sessionId;
    },
    async seedEval(sessionId, verdict, judge = "it_judge") {
      await sql`
        INSERT INTO session_external_evals (session_id, source, judge_name, verdict)
        VALUES (${sessionId}, ${run}, ${judge}, ${verdict})
      `;
    },
    async seedOutcome(sessionId, outcome) {
      await sql`
        INSERT INTO session_outcomes (session_id, source, outcome)
        VALUES (${sessionId}, ${run}, ${outcome})
      `;
    },
    createRule(over) {
      return insertAlertRule({
        ...RULE_DEFAULTS,
        ...over,
        name: `${run} ${over.metric ?? "rule"}`,
      });
    },
    async firingsFor(ruleId) {
      return await sql`SELECT * FROM alert_firings WHERE rule_id = ${ruleId}`;
    },
    async cleanup() {
      await sql`DELETE FROM alert_rules WHERE name LIKE ${run + "%"}`;
      await sql`DELETE FROM session_external_evals WHERE source = ${run}`;
      await sql`DELETE FROM session_outcomes WHERE source = ${run}`;
      await sql`DELETE FROM agent_transport_sessions WHERE account_id LIKE ${run + "%"}`;
    },
  };
}
