import { SQL } from "bun";
import { config } from "./config.js";

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
      ${JSON.stringify(session.chatHistory)}::jsonb,
      ${JSON.stringify(session.sessionMetrics)}::jsonb,
      ${session.rawReport != null ? JSON.stringify(session.rawReport) : null}::jsonb,
      ${session.recordUrl}
    )
  `;
}
