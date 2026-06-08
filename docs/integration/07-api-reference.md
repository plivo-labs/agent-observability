# API reference

AO's HTTP API, grouped by capability. This is the surface the dashboard itself
uses, so it's complete and current — but it's a **`v0`, evolving contract**;
pin to what you use and expect additive change.

## Conventions

- **Base URL** — wherever AO is served (e.g. `https://your-ao-host:9090`).
- **Auth** — when Basic auth is enabled, send
  `Authorization: Basic <base64(user:pass)>` on every `/api/*` and ingest route
  (`/health` is always open). Ingest routes also accept a LiveKit Bearer JWT.
  See [Auth & deployment](./06-auth-and-deployment.md).
- **List responses** — paginated as
  `{ "objects": [...], "meta": { "total_count", "limit", "offset", "next", "previous" } }`.
  `limit` clamps to `[1, 50]` (default 20).
- **JSON** in, JSON out, unless noted (ingest is multipart; some `/calls/*` are
  WebSocket).

## Ingest

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness (unauthenticated) |
| `POST` | `/observability/recordings/v0` | Session report (multipart). Basic or Bearer. |
| `POST` | `/observability/logs/otlp/v0` | OTLP logs — tags, evaluations, outcomes, report patches |
| `POST` | `/observability/traces/otlp/v0` | OTLP traces (accepted, 200 no-op) |
| `POST` | `/observability/metrics/otlp/v0` | OTLP metrics (accepted, 200 no-op) |
| `POST` | `/observability/evals/v0` | Eval run payload (pytest/vitest plugins) |

## Monitor — sessions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | List sessions. `?limit=&offset=&account_id=` |
| `GET` | `/api/sessions/:id` | Session detail: `chat_history`, computed `session_metrics`, `raw_report`, `events` |
| `DELETE` | `/api/sessions` | Bulk delete. Body `{ session_ids: string[] }` (max 200) |

## Evals

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/evals` | List eval runs (sims, live calls, CI runs). Filter by `account_id` / `agent_id` |
| `GET` | `/api/evals/:run_id` | One run with its cases |
| `GET` | `/api/evals/:run_id/cases/:case_id` | One case: transcript, judgments, failure |
| `DELETE` | `/api/evals` | Bulk delete. Body `{ run_ids: string[] }` (UUIDs); cascades to cases |

## Simulate

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/simulations` | Run a sim (synchronous/legacy) |
| `POST` | `/api/simulations/jobs` | Start a sim as a resumable server-side job → `{ jobId }` |
| `GET` | `/api/simulations/jobs/:id` | Poll job state (cases stream in); 404 when expired |
| `POST` | `/api/simulations/jobs/:id/cancel` | Cancel a running job |
| `POST` | `/api/personas/generate` | LLM-generate personas from a prompt (preview) |
| `GET` | `/api/personas` | Built-in + saved persona catalog |

## Live — calls

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/calls/config` | Whether real calling is configured (Truman enabled) |
| `POST` | `/api/calls` | Place one call |
| `POST` | `/api/calls/batch` | Place a suite (one call per persona) → `{ suiteId, calls }` |
| `GET` | `/api/calls/batch/:suiteId` | Poll suite status; persists an `eval_run` when terminal |
| `GET` | `/api/calls/audio/:runId` | Proxy the call recording (token stays server-side) |
| `POST` | `/api/calls/:runId/takeover/start` | Human grabs the mic |
| `POST` | `/api/calls/:runId/takeover/stop` | Hand control back to the persona |
| `POST` | `/api/calls/:runId/end-call` | End the call |
| `GET` (WS) | `/api/calls/:runId/stream` | Live transcript stream |
| `GET` (WS) | `/api/calls/:runId/audio` | Listen-in audio (both legs) |
| `GET` (WS) | `/api/calls/:runId/takeover/audio` | Director mic audio channel |
| `GET` | `/api/voices` | Available TTS voices (for persona voice selection) |

## Library

CRUD for reusable config. Built-in rows are read-only.

| Method | Path | Entity |
|---|---|---|
| `GET` / `POST` | `/api/library/personas` | Personas (list / create) |
| `PATCH` / `DELETE` | `/api/library/personas/:id` | Update / delete |
| `GET` / `POST` | `/api/library/rubrics` | Rubrics (criteria-based) |
| `PATCH` / `DELETE` | `/api/library/rubrics/:id` | Update / delete |
| `GET` / `POST` | `/api/library/scenarios` | Scenarios (runnable `sim.yaml`) |
| `DELETE` | `/api/library/scenarios/:id` | Delete |
| `GET` / `POST` | `/api/library/agents` | Agents (name, phone, prompt) |
| `PATCH` / `DELETE` | `/api/library/agents/:id` | Update / delete |

## Schedules & alerts

| Method | Path | Purpose |
|---|---|---|
| `GET` / `POST` | `/api/schedules` | List / create recurring runs |
| `PATCH` / `DELETE` | `/api/schedules/:id` | Update / delete |
| `POST` | `/api/schedules/:id/run` | Run a schedule now |
| `GET` | `/api/alerts` | Pass-rate-drop alerts recorded by the scheduler |

---

That's the full surface. For the data shapes behind each endpoint, the
authoritative source is the dashboard's API client and types (`frontend/src/lib`
and `frontend/src/components/simulate/sim-data.ts`). A formal OpenAPI/JSON-schema
export is on the roadmap.
