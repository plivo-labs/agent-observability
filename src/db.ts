import { SQL } from "bun";
import { config } from "./config.js";
import { normalizeRawReportPatch } from "./raw-report.js";
import { upsertAgentTx } from "./agents/upsert.js";
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

export async function insertSession(session: SessionInsert, tx: any = sql): Promise<void> {
  // estimated_cost_usd is populated later by mergeSessionRawReport when
  // the OTLP "session report" patch back-fills session_metrics.usage —
  // chat_history at insert time carries only timings (TTFT/TTFB/e2e
  // latency), not token counts, so computing here would persist a
  // misleading $0 for every voice-agent session.
  await tx`
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
  // Idempotent against at-least-once OTLP redelivery: a redelivered batch
  // carries a byte-identical evaluation payload, so skip the insert when an
  // identical row (same session/source/judge + exact raw payload) already
  // exists. Guarding on `raw` equality never drops a genuinely different
  // evaluation, and needs no unique constraint (so no migration that could
  // fail on pre-existing duplicates).
  await sql`
    INSERT INTO session_external_evals (
      session_id, source, judge_name, tag, verdict, reasoning, instructions, observed_at, raw
    )
    SELECT
      ${input.sessionId},
      ${input.source},
      ${input.judgeName},
      ${input.tag},
      ${input.verdict},
      ${input.reasoning},
      ${input.instructions},
      ${input.observedAt},
      ${input.raw}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM session_external_evals
      WHERE session_id = ${input.sessionId}
        AND source = ${input.source}
        AND judge_name = ${input.judgeName}
        AND raw = ${input.raw}::jsonb
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

  // Handle the OTLP-before-recording race. Every write below is an UPDATE
  // keyed on session_id; if the recording multipart hasn't created the row
  // yet, those UPDATEs match nothing and the usage/cost/events are lost.
  // Park the patch in session_raw_report_patches instead and return — it
  // gets replayed (in arrival order) by drainStagedRawReportPatches once
  // insertSession creates the row, mirroring the session_tags replay.
  const [sessionRow] = await sql`
    SELECT 1 AS present FROM agent_transport_sessions WHERE session_id = ${input.sessionId} LIMIT 1
  `;
  if (!sessionRow) {
    await sql`
      INSERT INTO session_raw_report_patches (session_id, patch)
      VALUES (${input.sessionId}, ${input.patch}::jsonb)
    `;
    return;
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

  // Price loading + cost computation hit the prices table only (not the
  // session row), so do them OUTSIDE the transaction below — the tx then
  // contains nothing but the session-row writes.
  let usageCost: number | null = null;
  const hasUsage = Array.isArray(patch.usage) && patch.usage.length > 0;
  if (hasUsage) {
    await ensurePricesLoaded();
    usageCost = costFromSessionUsage(patch.usage);
  }

  const events = Array.isArray(patch.events) ? patch.events : null;
  const restWithoutEvents = events ? (() => { const r = { ...patch }; delete r.events; return r; })() : null;

  // Atomicity (C3): these UPDATEs all key on the same session_id and
  // form one logical back-fill. Wrap them in a single transaction —
  // mirroring how the recordings handler in src/index.ts uses
  // sql.begin — so a mid-sequence failure can't leave the row with
  // agent_id promoted but usage/raw_report half-applied.
  await sql.begin(async (tx: any) => {
    if (agentId) {
      // Ensure the agents row exists BEFORE we set the FK column. The
      // primary OTLP path upserts upstream in persistLiveKitOtlpLogs, but
      // if agent_id arrives only via the rawReport body (no log.attributes
      // counterpart), the upstream guard is skipped and this UPDATE would
      // otherwise violate the agent_transport_sessions_agent_fkey added in
      // migration 012. upsertAgentTx is idempotent and shares the tx so
      // the agent row and the FK write commit/rollback together.
      await upsertAgentTx(tx, { agentId, accountId: null, agentName });
      await tx`
        UPDATE agent_transport_sessions
        SET agent_id = ${agentId}
        WHERE session_id = ${input.sessionId} AND agent_id IS NULL
      `;
    }
    if (agentName) {
      await tx`
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
    if (hasUsage) {
      // Cost is computed from the same `patch.usage` we're about to merge
      // and is persisted in the SAME UPDATE so the two values can never
      // drift. The WHERE clause gates BOTH writes on the row currently
      // having no usage — that way a duplicate OTLP patch can't write a
      // cost figure that doesn't correspond to the stored usage array.
      //
      // COALESCE on cost preserves any previously-set value (the column
      // is otherwise only written here, so this is effectively a NULL→
      // value transition, but the COALESCE keeps the column monotonic).
      await tx`
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
            estimated_cost_usd = COALESCE(estimated_cost_usd, ${usageCost})
        WHERE session_id = ${input.sessionId}
          AND (
            session_metrics IS NULL
            OR jsonb_typeof(session_metrics->'usage') <> 'array'
            OR jsonb_array_length(session_metrics->'usage') = 0
          )
      `;
    }

    if (events) {
      // Dedup against at-least-once OTLP redelivery: only append incoming
      // events whose item.id isn't already stored (id-less events are kept
      // as-is, since they can't be matched). Without this, a redelivered
      // chat-item batch would duplicate transcript lines.
      await tx`
        UPDATE agent_transport_sessions
        SET raw_report = (
          (
            CASE
              WHEN jsonb_typeof(raw_report) = 'object' THEN raw_report
              ELSE '{}'::jsonb
            END
          ) || ${restWithoutEvents}::jsonb || jsonb_build_object(
            'events',
            COALESCE(
              (
                CASE
                  WHEN jsonb_typeof(raw_report) = 'object' THEN raw_report
                  ELSE '{}'::jsonb
                END
              )->'events',
              '[]'::jsonb
            ) || COALESCE((
              SELECT jsonb_agg(incoming)
              FROM jsonb_array_elements(${events}::jsonb) AS incoming
              WHERE incoming->'item'->>'id' IS NULL
                 OR incoming->'item'->>'id' NOT IN (
                   SELECT existing->'item'->>'id'
                   FROM jsonb_array_elements(
                     COALESCE(
                       (
                         CASE
                           WHEN jsonb_typeof(raw_report) = 'object' THEN raw_report
                           ELSE '{}'::jsonb
                         END
                       )->'events',
                       '[]'::jsonb
                     )
                   ) AS existing
                   WHERE existing->'item'->>'id' IS NOT NULL
                 )
            ), '[]'::jsonb)
          )
        )
        WHERE session_id = ${input.sessionId}
      `;
      return;
    }

    await tx`
      UPDATE agent_transport_sessions
      SET raw_report = (
        CASE
          WHEN jsonb_typeof(raw_report) = 'object' THEN raw_report
          ELSE '{}'::jsonb
        END
      ) || ${patch}::jsonb
      WHERE session_id = ${input.sessionId}
    `;
  });
}

/**
 * Replay any raw_report patches that were parked because they arrived
 * before this session's recording row existed. Called by the recordings
 * handler right after insertSession (alongside applyStoredSessionTags).
 * Patches are replayed in arrival order through mergeSessionRawReport —
 * which now finds the row present — then deleted. Best-effort per patch:
 * one malformed parked patch can't block the rest.
 */
export async function drainStagedRawReportPatches(sessionId: string): Promise<void> {
  const rows = await sql`
    SELECT id, patch FROM session_raw_report_patches
    WHERE session_id = ${sessionId}
    ORDER BY id ASC
  `;
  for (const row of rows as Array<{ id: string; patch: Record<string, unknown> }>) {
    try {
      const patch = typeof row.patch === "string" ? JSON.parse(row.patch) : row.patch;
      await mergeSessionRawReport({ sessionId, patch });
      await sql`DELETE FROM session_raw_report_patches WHERE id = ${row.id}`;
    } catch (e) {
      console.error(
        `[otlp] failed to replay staged raw_report patch id=${row.id} ` +
          `session=${sessionId}: ${(e as Error).message}`,
      );
    }
  }
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
    // Accept the legacy dotted emitter prefix too, so both old
    // ("agent.name:") and new ("agent_name:") producers backfill the name.
    agentName ??= tagValue(tag.name, "agent.name:");
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

  const assignments: string[] = [];
  const params: unknown[] = [];
  if (accountId) {
    params.push(accountId);
    assignments.push(`account_id = $${params.length}`);
  }
  if (agentId) {
    // COALESCE so a later tag can't clobber an agent_id already promoted by
    // an earlier path — only fills when the column is still NULL, matching
    // the defensive pattern in mergeSessionRawReport.
    params.push(agentId);
    assignments.push(`agent_id = COALESCE(agent_id, $${params.length})`);
  }
  if (agentName) {
    params.push(agentName);
    assignments.push(`agent_name = COALESCE(agent_name, $${params.length})`);
  }
  if (transport) {
    params.push(transport);
    assignments.push(`transport = $${params.length}`);
  }
  params.push(sessionId);

  // upsertAgentTx (ensures the agent row exists for the FK) and the session
  // UPDATE share one transaction so a concurrent insertSession can't
  // interleave between them and leave the FK pointing at a not-yet-committed
  // agent row.
  await sql.begin(async (tx: any) => {
    if (agentId) {
      await upsertAgentTx(tx, { agentId, accountId, agentName });
    }
    await tx.unsafe(
      `UPDATE agent_transport_sessions
       SET ${assignments.join(", ")}
       WHERE session_id = $${params.length}`,
      params,
    );
  });
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
