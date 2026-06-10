import { sql } from "../db.js";
import type { AlertRuleCreate, AlertRulePatch } from "./schema.js";

export interface AlertRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  account_id: string | null;
  agent_id: string | null;
  trigger_type: string;
  judge_name: string | null;
  verdicts: string[];
  threshold_count: number | null;
  threshold_pass_rate: number | null;
  min_samples: number;
  window_minutes: number;
  webhook_url: string;
  http_method: string;
  secret: string | null;
  headers: Record<string, string> | null;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/** Split the `COUNT(*) OVER() AS _total` column off a page of rows. */
function takeTotal(rows: any[]): { rows: any[]; totalCount: number } {
  return {
    rows: rows.map(({ _total, ...rest }) => rest),
    totalCount: rows[0]?._total ?? 0,
  };
}

function mapRule(row: any): AlertRuleRow {
  return {
    ...row,
    verdicts: parseJsonb<string[]>(row.verdicts, []),
    headers: parseJsonb<Record<string, string> | null>(row.headers, null),
  };
}

export async function listAlertRules(
  limit: number,
  offset: number,
  filters: { agentId?: string | null; accountId?: string | null; enabled?: boolean | null } = {},
): Promise<{ rules: AlertRuleRow[]; totalCount: number }> {
  const agentId = filters.agentId ?? null;
  const accountId = filters.accountId ?? null;
  const enabled = filters.enabled ?? null;
  const rows = await sql`
    SELECT *, COUNT(*) OVER()::int AS _total
    FROM alert_rules
    WHERE (${agentId}::text IS NULL OR agent_id = ${agentId})
      AND (${accountId}::text IS NULL OR account_id = ${accountId})
      AND (${enabled}::boolean IS NULL OR enabled = ${enabled})
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const page = takeTotal(rows);
  return { rules: page.rows.map(mapRule), totalCount: page.totalCount };
}

export async function getAlertRule(id: string): Promise<AlertRuleRow | null> {
  const rows = await sql`SELECT * FROM alert_rules WHERE id = ${id}`;
  return rows[0] ? mapRule(rows[0]) : null;
}

export async function insertAlertRule(input: AlertRuleCreate): Promise<AlertRuleRow> {
  const rows = await sql`
    INSERT INTO alert_rules (
      name, enabled, account_id, agent_id, trigger_type, judge_name,
      verdicts, threshold_count, threshold_pass_rate, min_samples,
      window_minutes, webhook_url, http_method, secret, headers
    ) VALUES (
      ${input.name}, ${input.enabled}, ${input.account_id ?? null}, ${input.agent_id ?? null},
      ${input.trigger_type}, ${input.judge_name ?? null},
      ${input.verdicts}::jsonb,
      ${input.threshold_count ?? null}, ${input.threshold_pass_rate ?? null}, ${input.min_samples},
      ${input.window_minutes}, ${input.webhook_url}, ${input.http_method},
      ${input.secret ?? null},
      ${input.headers ?? null}::jsonb
    )
    RETURNING *
  `;
  return mapRule(rows[0]);
}

export async function updateAlertRule(id: string, patch: AlertRulePatch): Promise<AlertRuleRow | null> {
  // Fetch-merge-update: keys absent from the patch (undefined) keep their
  // stored value; explicit nulls clear nullable fields. A read-modify-write
  // race is acceptable on the single-instance deployment this targets.
  const existing = await getAlertRule(id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  };
  const rows = await sql`
    UPDATE alert_rules SET
      name = ${merged.name}, enabled = ${merged.enabled},
      account_id = ${merged.account_id}, agent_id = ${merged.agent_id},
      trigger_type = ${merged.trigger_type}, judge_name = ${merged.judge_name},
      verdicts = ${merged.verdicts}::jsonb,
      threshold_count = ${merged.threshold_count},
      threshold_pass_rate = ${merged.threshold_pass_rate},
      min_samples = ${merged.min_samples}, window_minutes = ${merged.window_minutes},
      webhook_url = ${merged.webhook_url}, http_method = ${merged.http_method},
      secret = ${merged.secret},
      headers = ${merged.headers ?? null}::jsonb,
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? mapRule(rows[0]) : null;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM alert_rules WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ── Firings ─────────────────────────────────────────────────────────────────

export interface AlertFiringRow {
  id: string;
  rule_id: string;
  window_start: string;
  window_end: string;
  matched_count: number;
  total_count: number | null;
  pass_rate: number | null;
  sample_session_ids: string[];
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  response_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapFiring(row: any): AlertFiringRow {
  return { ...row, sample_session_ids: parseJsonb<string[]>(row.sample_session_ids, []) };
}

export async function listFirings(
  ruleId: string,
  limit: number,
  offset: number,
): Promise<{ firings: AlertFiringRow[]; totalCount: number }> {
  const rows = await sql`
    SELECT *, COUNT(*) OVER()::int AS _total
    FROM alert_firings
    WHERE rule_id = ${ruleId}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const page = takeTotal(rows);
  return { firings: page.rows.map(mapFiring), totalCount: page.totalCount };
}

/** Due deliveries joined to their rule's webhook config. */
export interface DueDelivery extends AlertFiringRow {
  rule_name: string;
  trigger_type: string;
  judge_name: string | null;
  verdicts: string[];
  threshold_count: number | null;
  threshold_pass_rate: number | null;
  window_minutes: number;
  agent_id: string | null;
  account_id: string | null;
  webhook_url: string;
  http_method: string;
  secret: string | null;
  headers: Record<string, string> | null;
}

/** How long a claimed firing is leased before it becomes due again. If
 *  the claiming process crashes mid-delivery, the row simply re-becomes
 *  due after the lease — at-least-once with no stale-claim machinery. */
const CLAIM_LEASE = "2 minutes";

export async function claimDueFirings(limit = 50): Promise<DueDelivery[]> {
  // Atomic claim: push next_attempt_at forward in the same statement that
  // selects the batch (FOR UPDATE SKIP LOCKED), so two sweepers — e.g. an
  // inline API sweeper misconfigured alongside the worker — never deliver
  // the same firing. markDelivered/markRetry/markFailed overwrite the lease.
  const rows = await sql`
    WITH due AS (
      SELECT id FROM alert_firings
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE alert_firings f
    SET next_attempt_at = NOW() + ${CLAIM_LEASE}::interval, updated_at = NOW()
    FROM due, alert_rules r
    WHERE f.id = due.id AND r.id = f.rule_id
    RETURNING f.*,
              r.name AS rule_name, r.trigger_type, r.judge_name, r.verdicts,
              r.threshold_count, r.threshold_pass_rate, r.window_minutes,
              r.agent_id, r.account_id,
              r.webhook_url, r.http_method, r.secret, r.headers
  `;
  return rows.map((r: any) => ({
    ...mapFiring(r),
    verdicts: parseJsonb<string[]>(r.verdicts, []),
    headers: parseJsonb<Record<string, string> | null>(r.headers, null),
  }));
}

export async function markDelivered(id: string, responseStatus: number | null): Promise<void> {
  await sql`
    UPDATE alert_firings SET
      status = 'delivered', response_status = ${responseStatus},
      attempt_count = attempt_count + 1,
      last_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function markRetry(
  id: string,
  nextAttemptAt: Date,
  error: string | null,
  responseStatus: number | null,
): Promise<void> {
  await sql`
    UPDATE alert_firings SET
      attempt_count = attempt_count + 1,
      next_attempt_at = ${nextAttemptAt},
      last_attempt_at = NOW(),
      last_error = ${error}, response_status = ${responseStatus}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function markFailed(
  id: string,
  error: string | null,
  responseStatus: number | null,
): Promise<void> {
  await sql`
    UPDATE alert_firings SET
      status = 'failed',
      attempt_count = attempt_count + 1,
      last_attempt_at = NOW(),
      last_error = ${error}, response_status = ${responseStatus}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

// ── Webhook attempts (delivery audit trail) ─────────────────────────────────

export interface WebhookAttemptInput {
  ruleId: string | null;
  firingId: string | null;
  kind: "firing" | "test";
  url: string;
  httpMethod: string;
  attemptNumber: number;
  ok: boolean;
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
}

export async function insertWebhookAttempt(input: WebhookAttemptInput): Promise<void> {
  await sql`
    INSERT INTO alert_webhook_attempts (
      rule_id, firing_id, kind, url, http_method, attempt_number,
      ok, response_status, error, duration_ms
    ) VALUES (
      ${input.ruleId}, ${input.firingId}, ${input.kind}, ${input.url}, ${input.httpMethod},
      ${input.attemptNumber}, ${input.ok}, ${input.responseStatus}, ${input.error}, ${input.durationMs}
    )
  `;
}

export interface WebhookAttemptRow {
  id: string;
  rule_id: string | null;
  rule_name: string | null;
  firing_id: string | null;
  kind: "firing" | "test";
  url: string;
  http_method: string;
  attempt_number: number;
  ok: boolean;
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export async function listWebhookAttempts(
  ruleId: string | null,
  limit: number,
  offset: number,
): Promise<{ attempts: WebhookAttemptRow[]; totalCount: number }> {
  const rows = await sql`
    SELECT a.*, r.name AS rule_name, COUNT(*) OVER()::int AS _total
    FROM alert_webhook_attempts a
    LEFT JOIN alert_rules r ON r.id = a.rule_id
    WHERE (${ruleId}::uuid IS NULL OR a.rule_id = ${ruleId})
    ORDER BY a.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const page = takeTotal(rows);
  return { attempts: page.rows, totalCount: page.totalCount };
}

/** Aggregate webhook delivery stats for the alerts dashboard header. */
export async function getWebhookStats(range = "7d"): Promise<{
  total_attempts: number;
  accepted: number;
  acceptance_rate: number | null;
  avg_duration_ms: number | null;
  buckets: Array<{ bucket_start: string; attempts: number; accepted: number }>;
  rule_breakdown: Array<{
    rule_id: string | null;
    rule_name: string | null;
    attempts: number;
    accepted: number;
  }>;
}> {
  const interval = range === "24h" ? "24 hours" : range === "30d" ? "30 days" : "7 days";
  const bucket = range === "30d" ? "day" : "hour";

  const [totalsRows, bucketRows, ruleRows] = await Promise.all([
    sql.unsafe(
      `SELECT COUNT(*)::int AS total_attempts,
              COUNT(*) FILTER (WHERE ok)::int AS accepted,
              AVG(duration_ms)::int AS avg_duration_ms
       FROM alert_webhook_attempts
       WHERE created_at >= NOW() - $1::interval`,
      [interval],
    ),
    sql.unsafe(
      `SELECT date_trunc($2, created_at) AS bucket_start,
              COUNT(*)::int AS attempts,
              COUNT(*) FILTER (WHERE ok)::int AS accepted
       FROM alert_webhook_attempts
       WHERE created_at >= NOW() - $1::interval
       GROUP BY date_trunc($2, created_at)
       ORDER BY bucket_start ASC`,
      [interval, bucket],
    ),
    sql.unsafe(
      `SELECT a.rule_id, r.name AS rule_name,
              COUNT(*)::int AS attempts,
              COUNT(*) FILTER (WHERE a.ok)::int AS accepted
       FROM alert_webhook_attempts a
       LEFT JOIN alert_rules r ON r.id = a.rule_id
       WHERE a.created_at >= NOW() - $1::interval
       GROUP BY a.rule_id, r.name
       ORDER BY attempts DESC
       LIMIT 10`,
      [interval],
    ),
  ]);

  const totals = totalsRows[0] ?? {};
  const totalAttempts = totals.total_attempts ?? 0;
  return {
    total_attempts: totalAttempts,
    accepted: totals.accepted ?? 0,
    acceptance_rate: totalAttempts > 0 ? (totals.accepted ?? 0) / totalAttempts : null,
    avg_duration_ms: totals.avg_duration_ms ?? null,
    buckets: bucketRows,
    rule_breakdown: ruleRows,
  };
}
