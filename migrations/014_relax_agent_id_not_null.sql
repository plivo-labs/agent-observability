-- Allow agent_transport_sessions.agent_id to be NULL initially.
--
-- Migration 013 added agent_id as NOT NULL and the recording ingest
-- handler rejected uploads missing it with 400 missing_agent_id. That
-- gated agent-transport SDK uploads correctly (the SDK injects
-- agent_id into chat_history.tags[]) but rejected raw-LiveKit uploads
-- — LiveKit's _upload_session_report serializes ChatContext.to_dict()
-- which is items-only by default and doesn't carry tagger.tags. The
-- result: even when init_observability emitted the agent_id tag
-- correctly, it only rode on the OTLP "tag" body which arrives ~1s
-- after the recording multipart, by which point the recording had
-- already 400'd.
--
-- The right shape is the one account_id already follows: nullable
-- column, set by whichever channel resolves the value first.
-- `applySessionTagMetadata` (src/db.ts) already runs an UPDATE keyed
-- on session_id whenever an OTLP `agent_id:<value>` tag arrives, so
-- the backfill path exists today. We just need the row to land first.
--
-- Idempotent: DROP NOT NULL is safe to re-run.

ALTER TABLE agent_transport_sessions
  ALTER COLUMN agent_id DROP NOT NULL;

-- The agent_id index added in 013 stays; B-tree indexes happily index
-- NULLs (they sort last) and the dashboard's agent-scoped queries
-- filter on agent_id = $1 anyway, which excludes nulls implicitly.
