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
  seedAgent: (agentId: string, accountId?: string) => Promise<void>;
  seedSession: (opts: {
    accountId: string;
    agentId?: string;
    chatHistory?: unknown[] | null;
    perTurn?: Array<Record<string, unknown>>;
    /** When the per_turn array itself must be malformed (null, scalar…). */
    sessionMetrics?: unknown;
    endedMinutesAgo?: number;
  }) => Promise<string>;
  seedEval: (
    sessionId: string,
    verdict: string,
    judge?: string,
    createdMinutesAgo?: number,
  ) => Promise<void>;
  seedOutcome: (sessionId: string, outcome: string, updatedMinutesAgo?: number) => Promise<void>;
  createRule: (over: Partial<AlertRuleCreate>) => Promise<AlertRuleRow>;
  /** null clears the suppression stamp; a number back-dates it N minutes. */
  setLastFired: (ruleId: string, minutesAgo: number | null) => Promise<void>;
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
    async seedAgent(agentId, accountId) {
      await sql`
        INSERT INTO agents (agent_id, account_id)
        VALUES (${agentId}, ${accountId ?? null})
        ON CONFLICT (agent_id) DO NOTHING
      `;
    },
    async seedSession(opts) {
      const sessionId = uid("sess");
      const endedAgo = String(opts.endedMinutesAgo ?? 0);
      const metrics =
        opts.sessionMetrics !== undefined ? opts.sessionMetrics : { per_turn: opts.perTurn ?? [] };
      await sql`
        INSERT INTO agent_transport_sessions (
          session_id, account_id, agent_id, started_at, ended_at, duration_ms, turn_count,
          chat_history, session_metrics
        ) VALUES (
          ${sessionId}, ${opts.accountId}, ${opts.agentId ?? null},
          NOW() - (${endedAgo} || ' minutes')::interval - interval '2 minutes',
          NOW() - (${endedAgo} || ' minutes')::interval, 120000, 1,
          ${opts.chatHistory === undefined ? [] : opts.chatHistory}::jsonb,
          ${metrics}::jsonb
        )
      `;
      return sessionId;
    },
    async seedEval(sessionId, verdict, judge = "it_judge", createdMinutesAgo = 0) {
      await sql`
        INSERT INTO session_external_evals (session_id, source, judge_name, verdict, created_at)
        VALUES (${sessionId}, ${run}, ${judge}, ${verdict},
                NOW() - (${String(createdMinutesAgo)} || ' minutes')::interval)
      `;
    },
    async seedOutcome(sessionId, outcome, updatedMinutesAgo = 0) {
      await sql`
        INSERT INTO session_outcomes (session_id, source, outcome, updated_at)
        VALUES (${sessionId}, ${run}, ${outcome},
                NOW() - (${String(updatedMinutesAgo)} || ' minutes')::interval)
      `;
    },
    async setLastFired(ruleId, minutesAgo) {
      if (minutesAgo == null) {
        await sql`UPDATE alert_rules SET last_fired_at = NULL WHERE id = ${ruleId}`;
        return;
      }
      await sql`
        UPDATE alert_rules
        SET last_fired_at = NOW() - (${String(minutesAgo)} || ' minutes')::interval
        WHERE id = ${ruleId}
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
      await sql`DELETE FROM agents WHERE agent_id LIKE ${run + "%"}`;
    },
  };
}
