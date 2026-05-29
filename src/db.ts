import { SQL } from "bun";
import { config } from "./config.js";
import { normalizeRawReportPatch } from "./raw-report.js";
import { upsertAgent } from "./agents/upsert.js";
import { costFromSessionUsage } from "./evals/metrics.js";
import { ensurePricesLoaded } from "./evals/pricing.js";

export const sql = new SQL(config.DATABASE_URL);

interface SessionInsert {
  sessionId: string;
  accountId: string | null;
  /** Stable developer-supplied identifier. Pairs with `agentName` (label). */
  agentId: string | null;
  agentName: string | null;
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
  // estimated_cost_usd is populated later by mergeSessionRawReport when
  // the OTLP "session report" patch back-fills session_metrics.usage —
  // chat_history at insert time carries only timings (TTFT/TTFB/e2e
  // latency), not token counts, so computing here would persist a
  // misleading $0 for every voice-agent session.
  await sql`
    INSERT INTO agent_transport_sessions (
      session_id, account_id, agent_id, agent_name, transport, started_at, ended_at, duration_ms, turn_count,
      has_stt, has_llm, has_tts, chat_history, session_metrics, raw_report, record_url
    ) VALUES (
      ${session.sessionId},
      ${session.accountId},
      ${session.agentId},
      ${session.agentName},
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

  // Detect the OTLP-before-recording race. Every write below is an UPDATE
  // keyed on session_id; if the recording multipart hasn't created the row
  // yet, the usage/cost/events carried in this patch are silently dropped
  // (only session_tags are durable + replayed on insert via
  // applyStoredSessionTags). Log it so the gap is visible in prod — if this
  // never fires, the recording-first ordering holds and the heavier
  // insert→upsert fix isn't warranted.
  const [sessionRow] = await sql`
    SELECT 1 AS present FROM agent_transport_sessions WHERE session_id = ${input.sessionId} LIMIT 1
  `;
  if (!sessionRow) {
    console.warn(
      `[otlp] raw_report patch for session=${input.sessionId} arrived before its ` +
        `recording row; usage/cost/events in this patch will be dropped ` +
        `(keys=${Object.keys(patch).join(",")})`,
    );
  }

  // Promote agent_id and agent_name from the patch into their indexed
  // columns. The patch still carries them in raw_report (for fidelity);
  // the columns power the /api/agents distinct-aggregate query and the
  // sessions list filter. Mirrors how account_id is promoted via
  // applySessionTagMetadata.
  const agentId = typeof patch.agent_id === "string" && patch.agent_id.length > 0
    ? patch.agent_id
    : null;
  const agentName = typeof patch.agent_name === "string" && patch.agent_name.length > 0
    ? patch.agent_name
    : null;
  if (agentId) {
    // Ensure the agents row exists BEFORE we set the FK column. The
    // primary OTLP path upserts upstream in persistLiveKitOtlpLogs, but
    // if agent_id arrives only via the rawReport body (no log.attributes
    // counterpart), the upstream guard is skipped and this UPDATE would
    // otherwise violate the agent_transport_sessions_agent_fkey added in
    // migration 012. upsertAgent is idempotent.
    await upsertAgent({ agentId, accountId: null, agentName });
    await sql`
      UPDATE agent_transport_sessions
      SET agent_id = ${agentId}
      WHERE session_id = ${input.sessionId} AND agent_id IS NULL
    `;
  }
  if (agentName) {
    await sql`
      UPDATE agent_transport_sessions
      SET agent_name = ${agentName}
      WHERE session_id = ${input.sessionId} AND agent_name IS NULL
    `;
  }

  // Promote usage into session_metrics.usage when it arrives via the
  // OTLP "session report" patch. The recording multipart route may have
  // initialized session_metrics.usage to null because the chat_history
  // JSON didn't carry usage; the real per-model usage typically arrives
  // later on the OTLP channel. Without this back-fill, the session
  // detail page's token totals stay at 0 even though raw_report has
  // the data. Only writes when the current value is missing/empty so we
  // don't clobber a fresher value from a different path.
  if (Array.isArray(patch.usage) && patch.usage.length > 0) {
    // Cost is computed from the same `patch.usage` we're about to merge
    // and is persisted in the SAME UPDATE so the two values can never
    // drift. The WHERE clause gates BOTH writes on the row currently
    // having no usage — that way a duplicate OTLP patch can't write a
    // cost figure that doesn't correspond to the stored usage array.
    //
    // COALESCE on cost preserves any previously-set value (the column
    // is otherwise only written here, so this is effectively a NULL→
    // value transition, but the COALESCE keeps the column monotonic).
    await ensurePricesLoaded();
    const cost = costFromSessionUsage(patch.usage);
    await sql`
      UPDATE agent_transport_sessions
      SET session_metrics = jsonb_set(
            CASE
              WHEN jsonb_typeof(session_metrics) = 'object'
                THEN session_metrics
              ELSE '{}'::jsonb
            END,
            '{usage}',
            ${patch.usage}::jsonb,
            true
          ),
          estimated_cost_usd = COALESCE(estimated_cost_usd, ${cost})
      WHERE session_id = ${input.sessionId}
        AND (
          session_metrics IS NULL
          OR jsonb_typeof(session_metrics->'usage') <> 'array'
          OR jsonb_array_length(session_metrics->'usage') = 0
        )
    `;
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
  let agentId: string | null = null;
  let agentName: string | null = null;
  let transport: string | null = null;

  for (const tag of tags) {
    accountId ??= tagValue(tag.name, "account_id:");
    agentId ??= tagValue(tag.name, "agent_id:");
    agentName ??= tagValue(tag.name, "agent_name:");
    transport ??= tagValue(tag.name, "transport:");

    if (tag.name === "agent.session") {
      accountId ??= stringFromMetadata(tag.metadata, "account_id");
      agentId ??= stringFromMetadata(tag.metadata, "agent_id");
      agentName ??= stringFromMetadata(tag.metadata, "agent_name");
      transport ??= stringFromMetadata(tag.metadata, "transport");
    }
  }

  if (!accountId && !agentId && !agentName && !transport) {
    return;
  }

  // Ensure the agent row exists before the session UPDATE sets the
  // FK columns. Skipped when no agent_id was extracted from any tag.
  if (agentId) {
    await upsertAgent({ agentId, accountId, agentName });
  }

  const assignments: string[] = [];
  const params: unknown[] = [];
  if (accountId) {
    params.push(accountId);
    assignments.push(`account_id = $${params.length}`);
  }
  if (agentId) {
    params.push(agentId);
    assignments.push(`agent_id = $${params.length}`);
  }
  if (agentName) {
    params.push(agentName);
    assignments.push(`agent_name = $${params.length}`);
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
