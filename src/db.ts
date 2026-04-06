import { SQL } from "bun";
import { config } from "./config.js";

export const sql = new SQL(config.DATABASE_URL);

interface SessionInsert {
  sessionId: string;
  startedAt: Date | null;
  endedAt: Date;
  durationMs: number | null;
  turnCount: number;
  hasStt: boolean;
  hasLlm: boolean;
  hasTts: boolean;
  chatHistory: any;
  sessionMetrics: any;
  recordUrl: string | null;
}

export async function insertSession(session: SessionInsert): Promise<void> {
  await sql`
    INSERT INTO agent_transport_sessions (
      session_id, started_at, ended_at, duration_ms, turn_count,
      has_stt, has_llm, has_tts, chat_history, session_metrics, record_url
    ) VALUES (
      ${session.sessionId},
      ${session.startedAt},
      ${session.endedAt},
      ${session.durationMs},
      ${session.turnCount},
      ${session.hasStt},
      ${session.hasLlm},
      ${session.hasTts},
      ${JSON.stringify(session.chatHistory)},
      ${JSON.stringify(session.sessionMetrics)},
      ${session.recordUrl}
    )
  `;
}
