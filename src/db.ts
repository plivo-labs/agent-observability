import { SQL } from "bun";
import { config } from "./config.js";
import { normalizeRawReportPatch } from "./raw-report.js";

export const sql = new SQL(config.DATABASE_URL);

interface SessionInsert {
  sessionId: string;
  accountId: string | null;
  transport: string | null;
  startedAt: Date | null;
  endedAt: Date;
  durationMs: number | null;
  turnCount: number;
  hasStt: boolean;
  hasLlm: boolean;
  hasTts: boolean;
  chatHistory: any;
  sessionMetrics: any;
  rawReport: any;
  recordUrl: string | null;
}

interface SessionTagInput {
  sessionId: string;
  name: string;
  metadata: Record<string, unknown> | null;
  source: string;
  observedAt: Date | null;
}

interface LiveKitEvaluationInput {
  sessionId: string;
  source: string;
  judgeName: string;
  tag: string | null;
  verdict: string | null;
  reasoning: string | null;
  instructions: string | null;
  observedAt: Date | null;
  raw: Record<string, unknown>;
}

interface SessionOutcomeInput {
  sessionId: string;
  source: string;
  outcome: string;
  reason: string | null;
  observedAt: Date | null;
  raw: Record<string, unknown>;
}

interface SessionRawReportPatchInput {
  sessionId: string;
  patch: Record<string, unknown>;
}

export async function insertSession(session: SessionInsert): Promise<void> {
  await sql`
    INSERT INTO agent_transport_sessions (
      session_id, account_id, transport, started_at, ended_at, duration_ms, turn_count,
      has_stt, has_llm, has_tts, chat_history, session_metrics, raw_report, record_url
    ) VALUES (
      ${session.sessionId},
      ${session.accountId},
      ${session.transport},
      ${session.startedAt},
      ${session.endedAt},
      ${session.durationMs},
      ${session.turnCount},
      ${session.hasStt},
      ${session.hasLlm},
      ${session.hasTts},
      ${session.chatHistory}::jsonb,
      ${session.sessionMetrics}::jsonb,
      ${session.rawReport}::jsonb,
      ${session.recordUrl}
    )
  `;
}

export async function upsertSessionTag(input: SessionTagInput): Promise<void> {
  await sql`
    INSERT INTO session_tags (
      session_id, name, metadata, source, observed_at
    ) VALUES (
      ${input.sessionId},
      ${input.name},
      ${input.metadata}::jsonb,
      ${input.source},
      ${input.observedAt}
    )
    ON CONFLICT (session_id, name, source) DO UPDATE SET
      metadata = EXCLUDED.metadata,
      observed_at = COALESCE(EXCLUDED.observed_at, session_tags.observed_at),
      updated_at = NOW()
  `;
}

export async function insertLiveKitEvaluation(input: LiveKitEvaluationInput): Promise<void> {
  await sql`
    INSERT INTO session_external_evals (
      session_id, source, judge_name, tag, verdict, reasoning, instructions, observed_at, raw
    ) VALUES (
      ${input.sessionId},
      ${input.source},
      ${input.judgeName},
      ${input.tag},
      ${input.verdict},
      ${input.reasoning},
      ${input.instructions},
      ${input.observedAt},
      ${input.raw}::jsonb
    )
  `;
}

export async function upsertSessionOutcome(input: SessionOutcomeInput): Promise<void> {
  await sql`
    INSERT INTO session_outcomes (
      session_id, source, outcome, reason, observed_at, raw
    ) VALUES (
      ${input.sessionId},
      ${input.source},
      ${input.outcome},
      ${input.reason},
      ${input.observedAt},
      ${input.raw}::jsonb
    )
    ON CONFLICT (session_id, source) DO UPDATE SET
      outcome = EXCLUDED.outcome,
      reason = EXCLUDED.reason,
      observed_at = COALESCE(EXCLUDED.observed_at, session_outcomes.observed_at),
      raw = EXCLUDED.raw,
      updated_at = NOW()
  `;
}

export async function mergeSessionRawReport(input: SessionRawReportPatchInput): Promise<void> {
  const patch = normalizeRawReportPatch(input.patch);
  if (Object.keys(patch).length === 0) {
    return;
  }

  const events = Array.isArray(patch.events) ? patch.events : null;
  if (events) {
    const rest = { ...patch };
    delete rest.events;

    await sql`
      UPDATE agent_transport_sessions
      SET raw_report = (
        (
          CASE
            WHEN jsonb_typeof(raw_report) = 'object' THEN raw_report
            ELSE '{}'::jsonb
          END
        ) || ${rest}::jsonb || jsonb_build_object(
          'events',
          COALESCE(
            (
              CASE
                WHEN jsonb_typeof(raw_report) = 'object' THEN raw_report
                ELSE '{}'::jsonb
              END
            )->'events',
            '[]'::jsonb
          ) || ${events}::jsonb
        )
      )
      WHERE session_id = ${input.sessionId}
    `;
    return;
  }

  await sql`
    UPDATE agent_transport_sessions
    SET raw_report = (
      CASE
        WHEN jsonb_typeof(raw_report) = 'object' THEN raw_report
        ELSE '{}'::jsonb
      END
    ) || ${patch}::jsonb
    WHERE session_id = ${input.sessionId}
  `;
}

function stringFromMetadata(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tagValue(name: string, prefix: string): string | null {
  return name.startsWith(prefix) && name.length > prefix.length
    ? name.slice(prefix.length)
    : null;
}

export async function applySessionTagMetadata(
  sessionId: string,
  tags: Array<{ name: string; metadata: Record<string, unknown> | null }>,
): Promise<void> {
  let accountId: string | null = null;
  let transport: string | null = null;

  for (const tag of tags) {
    accountId ??= tagValue(tag.name, "account_id:");
    transport ??= tagValue(tag.name, "transport:");

    if (tag.name === "agent.session") {
      accountId ??= stringFromMetadata(tag.metadata, "account_id");
      transport ??= stringFromMetadata(tag.metadata, "transport");
    }
  }

  if (!accountId && !transport) {
    return;
  }

  const assignments: string[] = [];
  const params: unknown[] = [];
  if (accountId) {
    params.push(accountId);
    assignments.push(`account_id = $${params.length}`);
  }
  if (transport) {
    params.push(transport);
    assignments.push(`transport = $${params.length}`);
  }
  params.push(sessionId);

  await sql.unsafe(
    `UPDATE agent_transport_sessions
     SET ${assignments.join(", ")}
     WHERE session_id = $${params.length}`,
    params,
  );
}

export async function applyStoredSessionTags(sessionId: string): Promise<void> {
  const rows = await sql`
    SELECT name, metadata
    FROM session_tags
    WHERE session_id = ${sessionId}
  `;
  await applySessionTagMetadata(
    sessionId,
    rows.map((row: any) => ({
      name: row.name,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
    })),
  );
}
