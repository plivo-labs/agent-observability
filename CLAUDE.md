# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

Agent Observability is a Bun/Hono server that receives session report callbacks from agent-transport (Python and Node SDKs). It verifies LiveKit JWT auth, parses the multipart session report (protobuf header, chat history JSON, audio OGG), stores session data in Postgres, and serves a dashboard UI for viewing session metrics.

## Commands

```bash
bun run dev              # Start backend with hot reload (port 9090)
bun run dev:frontend     # Start Vite dev server (port 5173, proxies /api to :9090)
bun run build:frontend   # Build frontend for production
bun run start            # Start production server (API + static files)
docker compose up        # Start Postgres + app
docker compose up postgres -d  # Postgres only for local dev
```

## Architecture

### Backend (`src/`)

- `src/index.ts` — Hono HTTP server. Health check at `/health`. Session report at `POST /observability/recordings/v0`. Dashboard API at `/api/sessions*`. In production, serves frontend static files.
- `src/config.ts` — Zod-validated env config. All env vars are read here.
- `src/db.ts` — Bun SQL client (`bun:sql`). `insertSession()` writes to `agent_transport_sessions`.
- `src/metrics.ts` — Transforms raw `chat_history` and `session_metrics` JSONB into structured `SessionMetrics` format with per-turn data and summary statistics.
- `src/migrate.ts` — Raw SQL migration runner. Reads `migrations/*.sql`, tracks applied ones in `_migrations` table.
- `src/s3.ts` — Optional S3 upload for audio recordings using Bun's built-in S3 client.

### Frontend (`frontend/`)

- Vite + React 19 + TypeScript + ShadCN UI + Tailwind CSS v4
- `frontend/src/pages/sessions.tsx` — Sessions list page with table and pagination
- `frontend/src/pages/session-detail.tsx` — Session detail with tabs (Session/Performance/Config)
- `frontend/src/components/charts/` — Metric visualization: summary cards, latency percentiles, pipeline breakdown, latency over turns, token usage
- `frontend/src/components/turn-transcript.tsx` — Conversation transcript view
- `frontend/src/lib/api.ts` — API client for fetching session data
- `frontend/src/lib/types.ts` — Shared TypeScript types
- `frontend/src/lib/format.ts` — Formatting utilities (ms, duration, date)

### Vite Backend Integration

- **Dev**: Vite dev server on :5173 proxies `/api/*` to Hono on :9090
- **Prod**: `vite build` outputs to `frontend/dist/`, Hono serves these as static files

## Session Report Flow

1. Agent-transport SDK sends multipart POST to `/observability/recordings/v0` with JWT auth
2. Server verifies JWT using `LIVEKIT_API_KEY` (issuer) and `LIVEKIT_API_SECRET` (HS256 secret)
3. Parses: protobuf header (`@livekit/protocol` MetricsRecordingHeader), chat history (JSON), audio (OGG)
4. Extracts session_id (from header's `roomId`), turn count, STT/LLM/TTS flags, per-turn metrics
5. Optionally uploads audio to S3
6. Saves to `agent_transport_sessions` table

## Dashboard API

- `GET /api/sessions?page=1&limit=50` — List sessions (paginated)
- `GET /api/sessions/:id` — Session detail with chat_history
- `GET /api/sessions/:id/metrics` — Computed session metrics (turns, summary)

## Migrations

SQL files in `migrations/` folder, named `001_description.sql`, `002_description.sql`, etc. Applied automatically on startup when `AUTO_MIGRATE=true`. Tracked in `_migrations` table.

## Environment Variables

See `.env.example` for all variables. Required: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DATABASE_URL`.

## Releasing

The UI package (`packages/ui/`, published as `agent-observability-ui`) publishes to npm via PR label — no manual tags or releases needed.

1. Bump `version` in `packages/ui/package.json`.
2. **Version bumps must be in a dedicated PR** — do not mix with feature changes.
3. Labels:
   - `release-ui-pkg` — apply to the version-bump PR to trigger the publish.
   - `agent-observability-ui` — apply to feature/fix PRs you want listed in the next release's notes.
4. Merge to `main`. `Tests` runs, then `Publish UI Package` picks up the merged commit, publishes `bin/cli.mjs` to npm, and creates a `ui-v<version>` GitHub Release with notes listing every `agent-observability-ui`-labeled PR merged since the previous `ui-v*` tag.

> **Note:** The registry JSON under `packages/ui/public/r/` is served from git via `raw.githubusercontent.com` — it is **not** shipped in the npm tarball. If you add or change a registry item in `registry.json`, run `cd packages/ui && bun run build` and commit the regenerated `public/r/*.json` files in the same PR.

### Prerequisites (one-time setup)

- **npm:** `NPM_TOKEN` must be set as a repository Actions secret (an npm automation token with publish rights for `agent-observability-ui`).
- **GitHub labels:** Create `release-ui-pkg` (publish trigger) and `agent-observability-ui` (release notes filter) in the repo.
