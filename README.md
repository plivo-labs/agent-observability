# Agent Observability

[![Tests](https://img.shields.io/github/actions/workflow/status/plivo-labs/agent-observability/test.yml?branch=main&label=tests)](https://github.com/plivo-labs/agent-observability/actions/workflows/test.yml)
[![agent-observability-ui](https://img.shields.io/npm/v/agent-observability-ui.svg?label=agent-observability-ui)](https://www.npmjs.com/package/agent-observability-ui)
[![agent-observability-sdk (npm)](https://img.shields.io/npm/v/agent-observability-sdk.svg?label=agent-observability-sdk%20%28npm%29)](https://www.npmjs.com/package/agent-observability-sdk)
[![agent-observability-sdk (PyPI)](https://img.shields.io/pypi/v/agent-observability-sdk.svg?label=agent-observability-sdk%20%28PyPI%29)](https://pypi.org/project/agent-observability-sdk/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Session report callback server for [agent-transport](https://github.com/plivo-labs/agent-transport) with a built-in dashboard UI and a [shadcn component registry](packages/ui/README.md) for embedding observability views in your own app.

## What it does

When a voice agent call ends, the agent-transport SDK uploads a session report containing:
- **Chat transcript** — full conversation with per-turn metrics (e2e latency, TTS TTFB, LLM TTFT, STT delay)
- **Audio recording** — OGG/Opus call recording (optional)
- **Session metadata** — session ID, start time, duration

This server receives that report, extracts session metrics, optionally uploads the audio to S3, and saves everything to Postgres. The dashboard UI lets you browse sessions and view detailed performance metrics.

## Setup

### Recommended: Docker Compose

The easiest way to run the server is Docker Compose. It builds the frontend,
starts Postgres, runs migrations, and serves the API plus dashboard on
http://localhost:9090.

Prerequisite: Docker with Compose.

```bash
git clone https://github.com/plivo-labs/agent-observability
cd agent-observability
cp .env.example .env
docker compose up --build
```

The compose file points `DATABASE_URL` at the bundled Postgres container and
sets `AUTO_MIGRATE=true`. Edit `.env` only when you want optional basic auth or
S3 recording upload settings.

### Local Development

Use the Bun flow when you want to work on the backend, frontend, or component
registry directly.

Prerequisites:

- [Bun](https://bun.sh) runtime
- Postgres database

Install dependencies:

```bash
bun install
cd frontend && bun install && cd ..
# Optional, only if working on the component library
cd packages/ui && bun install && cd ..
cp .env.example .env  # set DATABASE_URL (required); AGENT_OBSERVABILITY_USER/PASS enable basic auth
```

Set `DATABASE_URL` in `.env` to your local Postgres database.

Run the backend and frontend dev servers:

```bash
# Terminal 1: Backend (Hono server on :9090)
bun run dev

# Terminal 2: Frontend (Vite dev server on :5173, proxies /api to :9090)
bun run dev:frontend
```

Open http://localhost:5173 for the dashboard.

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
npx agent-observability-ui@latest add metric-summary-cards

# Install the full dashboard (pulls in everything)
npx agent-observability-ui@latest add session-detail-page
```

See the [full documentation](packages/ui/README.md) for usage, available components, and hooks. Releases are automated — see [Releasing](CLAUDE.md#releasing) for the publish flow.

### Docs site

Live playground: **https://plivo-labs.github.io/agent-observability/** — browse every component with mock data, no install required.

To run locally:

```bash
cd docs
bun install
bun run dev  # http://localhost:5174/agent-observability/
```

## Eval Plugins

Language-native test-framework plugins stream eval runs into the same
dashboard. Each `pytest` or `vitest` invocation lands as one `eval_run`
with every test surfacing as an `eval_case` — function-call assertions,
LLM-judge verdicts, agent handoffs, and failure detail are captured
automatically.

| Package | Framework | Docs |
|---|---|---|
| [`agent-observability-sdk`](plugins/agent-observability-sdk/README.md) | pytest (Python) | Judges + pytest plugin: install, configure, env vars, and how to invoke pytest from a FastAPI server |
| [`agent-observability-sdk`](plugins/agent-observability-sdk-node/README.md) | Vitest (Node/TS) | Vitest reporter: install, configure, env vars, and how to invoke Vitest from a Bun/Node HTTP server via `startVitest` |

Runnable reference suites for both frameworks — including simple agents,
a multi-agent banking example, LLM-generated scenarios, and the HTTP
runners — live under [`plugins/examples/`](plugins/examples/README.md).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Postgres connection string |
| `AGENT_OBSERVABILITY_USER` | No | Basic auth username — when set with `AGENT_OBSERVABILITY_PASS`, native ingest routes accept Basic credentials |
| `AGENT_OBSERVABILITY_PASS` | No | Basic auth password (see above) |
| `LIVEKIT_API_KEY` | No | Issuer identifier for LiveKit Bearer JWTs. The LiveKit SDK requires this pair to initialize and signs every observability payload (recordings, OTLP) with it — the observability server must verify against the same pair, since that's the credential the SDK signs with. You generate the pair yourself; see [Generating a LiveKit API key/secret](#generating-a-livekit-api-keysecret). |
| `LIVEKIT_API_SECRET` | No | HS256 signing secret paired with `LIVEKIT_API_KEY`. Both env vars are required to enable LiveKit Bearer auth. |
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
| `GET` | `/health` | Health check (always unauthenticated) |
| `POST` | `/observability/recordings/v0` | Session report (multipart with JSON or protobuf `MetricsRecordingHeader` + JSON `chat_history` + optional OGG audio). Accepts Basic auth or LiveKit Bearer JWT. |
| `POST` | `/observability/logs/otlp/v0` | OTLP log records emitted by the LiveKit SDK Tagger or hand-built equivalents. Accepts JSON / protobuf, gzip-encoded or not. Persists tags, judge evaluations, outcomes, and session-report patches. |
| `POST` | `/observability/traces/otlp/v0` | OTLP traces — accepted but not persisted yet (200 no-op). |
| `POST` | `/observability/metrics/otlp/v0` | OTLP metrics — accepted but not persisted yet (200 no-op). Per-turn agent metrics ride on `chat_history` items in the recording payload, not here. |
| `POST` | `/observability/evals/v0` | Eval run payload from the pytest / vitest plugins |

### Dashboard API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List sessions (paginated: `?limit=20&offset=0`) |
| `GET` | `/api/sessions/:id` | Session detail |
| `GET` | `/api/evals` | List eval runs |
| `GET` | `/api/evals/:run_id` | Single eval run with its cases |
| `GET` | `/api/evals/:run_id/cases/:case_id` | One case with transcript, judgments, failure |

### Dashboard UI

In production, the Vite-built frontend is served as static files from the same server. In development, the Vite dev server proxies API requests to the backend.

## Database

### `agent_transport_sessions` (one row per call)

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

### LiveKit OTLP-derived tables

Populated by the OTLP logs ingest path; joined to a session via `session_id`.

| Table | Purpose |
|-------|---------|
| `session_tags` | Tagger annotations (e.g. `agent.session`, `account_id:…`, `transport:sip`). Unique on `(session_id, name, source)`. |
| `session_external_evals` | LiveKit `JudgeGroup` outcomes — one row per (session, judge): `judge_name`, `verdict`, `tag`, `reasoning`, `instructions`, `raw`. |
| `session_outcomes` | High-level pass/fail outcome summaries. Unique on `(session_id, source)`. |

Migrations run automatically when `AUTO_MIGRATE=true`.

## Agent-Transport Configuration

Set these in the agent process to enable session report upload:

```bash
AGENT_OBSERVABILITY_URL=https://your-server:9090

# Option A — legacy basic auth (older agent-transport clients)
AGENT_OBSERVABILITY_USER=your_user
AGENT_OBSERVABILITY_PASS=your_pass

# Option B — LiveKit-native auth (agent-transport >= 0.1.10)
# The LiveKit SDK requires this pair to initialize and signs every payload
# it emits (recordings, OTLP logs/traces) with it. The observability server
# verifies against the same pair because that is the only credential the SDK
# signs with. See "Generating a LiveKit API key/secret" below for how to
# create the values.
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
```

The server accepts whichever auth header the client sends. Either option
on its own is enough; configure both during a migration window if you have
mixed clients.

### Generating a LiveKit API key/secret

`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are not issued by a LiveKit
cloud service — they are an HS256 keypair you generate locally and
configure on both sides:

- The agent process passes them to the LiveKit SDK, which signs Bearer
  JWTs (and the OTLP payloads) with the secret using the key as the
  `iss` claim.
- The observability server reads the same pair from its env and verifies
  incoming JWT signatures against the secret, requiring `iss` to equal
  the key.

Generate them once with `openssl` (or any source of cryptographic
randomness) and store them in your secrets manager:

```bash
LIVEKIT_API_KEY="API$(openssl rand -hex 6)"        # short identifier, e.g. APIa1b2c3d4e5f6
LIVEKIT_API_SECRET="$(openssl rand -base64 48)"    # high-entropy HS256 signing secret
```

Distribute the same values to every agent process and to the
observability server. Rotating the pair is a coordinated change: update
the secret store, redeploy the agents (so the SDK picks up the new
signing key), and redeploy the observability server (so it verifies
against the new key) within the same window.

## Project Structure

```
agent-observability/
├── src/                              # Backend (Bun/Hono)
├── frontend/                         # Dashboard app (Vite + React)
├── packages/ui/                      # shadcn component registry
│   ├── registry/                     # Component source
│   └── tests/                        # Unit tests
├── docs/                             # Docs site (preview app, deployed to GH Pages)
├── plugins/                          # Language SDKs + runnable examples
│   ├── agent-observability-sdk/      # Python SDK: judges + pytest plugin
│   ├── agent-observability-sdk-node/ # Node SDK: Vitest reporter + helpers
│   └── examples/                     # Runnable eval suites (python/ + node/)
├── migrations/                       # SQL migrations
└── tests/                            # Server tests
```
