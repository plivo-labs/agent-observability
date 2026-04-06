# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

Agent Observability is a Bun/Hono server that receives session report callbacks from agent-transport (Python and Node SDKs). It verifies LiveKit JWT auth, parses the multipart session report (protobuf header, chat history JSON, audio OGG), and stores session data in Postgres.

## Commands

```bash
bun run dev              # Start dev server with hot reload (port 9090)
docker compose up        # Start Postgres + app
docker compose up postgres -d  # Postgres only for local dev
```

## Architecture

- `src/index.ts` — Hono HTTP server. Health check at `/health`. Session report endpoint at `POST /observability/recordings/v0`.
- `src/config.ts` — Zod-validated env config. All env vars are read here.
- `src/db.ts` — Bun SQL client (`bun:sql`). `insertSession()` writes to `agent_transport_sessions`.
- `src/migrate.ts` — Raw SQL migration runner. Reads `migrations/*.sql`, tracks applied ones in `_migrations` table.
- `src/s3.ts` — Optional S3 upload for audio recordings using Bun's built-in S3 client.

## Session Report Flow

1. Agent-transport SDK sends multipart POST to `/observability/recordings/v0` with JWT auth
2. Server verifies JWT using `LIVEKIT_API_KEY` (issuer) and `LIVEKIT_API_SECRET` (HS256 secret)
3. Parses: protobuf header (`@livekit/protocol` MetricsRecordingHeader), chat history (JSON), audio (OGG)
4. Extracts session_id (from header's `roomId`), turn count, STT/LLM/TTS flags, per-turn metrics
5. Optionally uploads audio to S3
6. Saves to `agent_transport_sessions` table

## Migrations

SQL files in `migrations/` folder, named `001_description.sql`, `002_description.sql`, etc. Applied automatically on startup when `AUTO_MIGRATE=true`. Tracked in `_migrations` table.

## Environment Variables

See `.env.example` for all variables. Required: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DATABASE_URL`.
