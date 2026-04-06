CREATE TABLE IF NOT EXISTS agent_transport_sessions (
    id                  SERIAL PRIMARY KEY,
    session_id          TEXT NOT NULL,
    state               TEXT NOT NULL DEFAULT 'ended',
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms         INTEGER,
    turn_count          INTEGER DEFAULT 0,
    has_stt             BOOLEAN NOT NULL DEFAULT FALSE,
    has_llm             BOOLEAN NOT NULL DEFAULT FALSE,
    has_tts             BOOLEAN NOT NULL DEFAULT FALSE,
    chat_history        JSONB,
    session_metrics     JSONB,
    record_url          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ats_session_id ON agent_transport_sessions (session_id);
CREATE INDEX IF NOT EXISTS idx_ats_ended_at ON agent_transport_sessions (ended_at DESC);
