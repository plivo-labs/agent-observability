# Agent Observability

Session report callback server for [agent-transport](https://github.com/plivo-labs/agent-transport) with a built-in dashboard UI and a [shadcn component registry](packages/ui/README.md) for embedding observability views in your own app.

## What it does

When a voice agent call ends, the agent-transport SDK uploads a session report containing:
- **Chat transcript** — full conversation with per-turn metrics (e2e latency, TTS TTFB, LLM TTFT, STT delay)
- **Audio recording** — OGG/Opus call recording (optional)
- **Session metadata** — session ID, start time, duration

This server receives that report, extracts session metrics, optionally uploads the audio to S3, and saves everything to Postgres. The dashboard UI lets you browse sessions and view detailed performance metrics.

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- Postgres database
- LiveKit API key/secret (for JWT verification of agent-transport callbacks)

### Install

```bash
# Server dependencies
bun install

# Frontend dependencies
cd frontend && bun install && cd ..

# UI registry dependencies (optional — only if working on the component library)
cd packages/ui && bun install && cd ..

# Environment config
cp .env.example .env  # fill in LIVEKIT_API_KEY, LIVEKIT_API_SECRET, DATABASE_URL
```

### Development

Run the backend and frontend dev servers:

```bash
# Terminal 1: Backend (Hono server on :9090)
bun run dev

# Terminal 2: Frontend (Vite dev server on :5173, proxies /api to :9090)
bun run dev:frontend
```

Open http://localhost:5173 for the dashboard.

### With Docker

```bash
docker compose up
```

### Production Build

```bash
bun run build:frontend
bun run start  # serves API + static frontend on :9090
```

### Tests

```bash
# Server tests
bun test

# UI component tests
cd packages/ui && bun test
```

## UI Component Library

The dashboard components are also available as a **shadcn registry** at [`packages/ui/`](packages/ui/README.md). Consumers install components into their own project via `npx shadcn add` — code is copied in, fully customizable, and wired up with a provider + hooks pattern.

```bash
# Install a component into your project
npx @plivo-labs/agent-observability-ui@latest add metric-summary-cards

# Install the full dashboard (pulls in everything)
npx @plivo-labs/agent-observability-ui@latest add session-detail-page
```

See the [full documentation](packages/ui/README.md) for usage, available components, hooks, and the preview app.

### Preview App

A standalone app to browse all components with mock data:

```bash
cd packages/ui/preview
bun install
bun run dev  # http://localhost:5174
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LIVEKIT_API_KEY` | Yes | Verifies JWT `iss` claim from agent-transport |
| `LIVEKIT_API_SECRET` | Yes | HS256 secret for JWT verification |
| `DATABASE_URL` | Yes | Postgres connection string |
| `AUTO_MIGRATE` | No | Run SQL migrations on startup (`true`/`false`, default: `false`) |
| `PORT` | No | Server port (default: `9090`) |
| `S3_BUCKET` | No | Enable S3 upload for audio recordings |
| `S3_REGION` | No | AWS region (default: `us-east-1`) |
| `S3_ACCESS_KEY_ID` | No | Required if `S3_BUCKET` is set |
| `S3_SECRET_ACCESS_KEY` | No | Required if `S3_BUCKET` is set |
| `S3_ENDPOINT` | No | Custom S3 endpoint (for S3-compatible services) |
| `S3_PREFIX` | No | Key prefix for uploads (default: `recordings`) |

## Endpoints

### Ingest

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/observability/recordings/v0` | Session report callback (JWT authenticated) |

### Dashboard API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List sessions (paginated: `?limit=20&offset=0`) |
| `GET` | `/api/sessions/:id` | Session detail |

### Dashboard UI

In production, the Vite-built frontend is served as static files from the same server. In development, the Vite dev server proxies API requests to the backend.

## Database

Sessions are stored in the `agent_transport_sessions` table:

| Column | Type | Description |
|--------|------|-------------|
| `session_id` | TEXT | Call session identifier |
| `account_id` | TEXT | Account identifier (multi-tenant) |
| `started_at` | TIMESTAMPTZ | Call start time |
| `ended_at` | TIMESTAMPTZ | Call end time |
| `duration_ms` | BIGINT | Call duration in milliseconds |
| `turn_count` | INTEGER | Number of conversation turns |
| `has_stt` | BOOLEAN | Speech-to-text was used |
| `has_llm` | BOOLEAN | LLM was used |
| `has_tts` | BOOLEAN | Text-to-speech was used |
| `chat_history` | JSONB | Full transcript with per-turn metrics |
| `session_metrics` | JSONB | Aggregated latency metrics |
| `record_url` | TEXT | S3 URL for audio recording |

Migrations run automatically when `AUTO_MIGRATE=true`.

## Agent-Transport Configuration

Set these in the agent process to enable session report upload:

```bash
LIVEKIT_OBSERVABILITY_URL=https://your-server:9090
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
```

## Project Structure

```
agent-observability/
├── src/                    # Backend (Bun/Hono)
├── frontend/               # Dashboard app (Vite + React)
├── packages/ui/            # shadcn component registry
│   ├── registry/           # Component source
│   ├── preview/            # Preview app
│   └── tests/              # Unit tests
├── migrations/             # SQL migrations
└── tests/                  # Server tests
```
