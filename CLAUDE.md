# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

Agent Observability is a Bun/Hono server that receives session report callbacks from agent-transport (Python and Node SDKs). It parses the multipart session report (JSON header, chat history JSON, audio OGG), stores session data in Postgres, and serves a dashboard UI for viewing session metrics. All routes except `/health` can be gated with optional HTTP basic auth (`AGENT_OBSERVABILITY_USER` / `AGENT_OBSERVABILITY_PASS`).

**It is evolving into a voice-agent QA platform** (per the integration plan — see "QA platform" section below). Beyond observability (**Monitor** / **Evals**) it now adds **Simulate** (VAD-style text persona sims), **Live** (Truman-model calling — a *suite* of one-call-per-persona runs with criteria scoring + takeover), a **Library** (Personas / Rubrics / Scenarios), and **Schedules** (recurring runs + alerts). Simulation and call runs persist into the Evals tab as `eval_runs`, so everything lives on one timeline.

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

- `src/index.ts` — Hono HTTP server. Health check at `/health`. Session report at `POST /observability/recordings/v0`. OTLP ingest at `/observability/{logs,traces,metrics}/otlp/v0`. Dashboard API at `/api/sessions*`. In production, serves frontend static files.
- `src/config.ts` — Zod-validated env config. All env vars are read here.
- `src/db.ts` — Bun SQL client (`bun:sql`). `insertSession()` writes to `agent_transport_sessions`; `upsertSessionTag` / `insertLiveKitEvaluation` / `upsertSessionOutcome` / `mergeSessionRawReport` populate the LiveKit OTLP-derived tables.
- `src/metrics.ts` — Transforms raw `chat_history` and `session_metrics` JSONB into structured `SessionMetrics` format with per-turn data and summary statistics.
- `src/migrate.ts` — Raw SQL migration runner. Reads `migrations/*.sql`, tracks applied ones in `_migrations` table.
- `src/s3.ts` — Optional S3 upload for audio recordings using Bun's built-in S3 client.
- `src/raw-report.ts` — Generic `voice.SessionReport` JSON normalizer (parses stringified JSON attrs, hoists function_call / function_call_output / agent_handoff payloads, merges multi-fragment arrays).
- `src/livekit/auth.ts` — Dual-auth middleware: accepts Basic credentials (`AGENT_OBSERVABILITY_USER`/`_PASS`) **or** LiveKit-issued HS256 Bearer JWTs. The JWT issuer claim must equal the LiveKit API key env value; the signature is verified against the matching API secret env value (see `.env.example` for the full pair). Payload must carry `observability.write === true`. Mounted on every native ingest path.
- `src/livekit/protobuf.ts` — Hand-rolled decoders for `MetricsRecordingHeader` (recording multipart `header.binpb` part) and OTLP logs (handles JSON, protobuf, and gzip).
- `src/livekit/observability.ts` — `persistLiveKitOtlpLogs(logs)`. Branches on each record's `body` field: `"session report"` (merge into raw_report patch), `"chat item"` (append events), `"tag"` (upsert `session_tags`), `"evaluation"` (insert `session_external_evals`), `"outcome"` (upsert `session_outcomes`).

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

### Sharing code between `packages/ui` and `frontend/`

The dashboard (`frontend/`) and the published registry (`packages/ui/`) share runtime helpers — e.g., `observability-types`, `observability-format`, `observability-hooks`, `observability-events`. The convention:

- Source of truth lives at `packages/ui/registry/new-york/<name>/<name>.ts` and is published as a registry item via `packages/ui/public/r/<name>.json` (regenerated with `cd packages/ui && bun run build`).
- `frontend/src/lib/<name>.ts` is a **standalone copy** of that source — same content verbatim. The `@/lib/...` imports inside resolve correctly in both surfaces (vite alias `@`→`./src` for the frontend, tsconfig path for `packages/ui`).
- **Never** import from `packages/` inside `frontend/src/**` — not via relative path (`../../../packages/...`), not via alias. External consumers install components with `npx shadcn add <raw.githubusercontent.com URL>`; shadcn CLI copies the file you point it at and does **not** follow re-exports, so a re-export across the boundary leaves external consumers with a stub. The dashboard must look exactly like an external consumer to keep the contract honest.
- When adding a new shared helper: author it under `packages/ui/registry/new-york/`, register it in `packages/ui/registry.json`, regenerate `public/r/`, then place a verbatim copy at `frontend/src/lib/<name>.ts`.
- Smell test: `grep -rn "packages/" frontend/src/ --include='*.ts' --include='*.tsx'` — only JSDoc URL comments should match.

## Session Report Flow

1. Agent-transport SDK sends multipart POST to `/observability/recordings/v0`. Auth: Basic when `AGENT_OBSERVABILITY_USER`/`_PASS` are set; LiveKit Bearer JWT (HS256; issuer claim is the LiveKit API key env value; signature verified using the matching API secret env value; payload carries `observability.write === true`) when the LiveKit env pair is set. Either auth mode on its own is enough; both are supported during a migration window.
2. Parses the `header` part as JSON first (`session_id`, `start_time`, `room_tags.account_id`, `transport`); falls back to `decodeMetricsRecordingHeader` (protobuf `MetricsRecordingHeader`, native LiveKit shape) when JSON parse fails. Chat history JSON carries per-turn metrics + usage; audio is OGG.
3. Extracts turn count and STT/LLM/TTS flags from chat history items.
4. Optionally uploads audio to S3 (when `S3_BUCKET` and credentials are set).
5. Saves to `agent_transport_sessions` table.

Native LiveKit observability also accepts OTLP log records at `POST /observability/logs/otlp/v0` (JSON or protobuf, gzip optional). `persistLiveKitOtlpLogs` branches on each record's `body` field — `"session report"` merges into raw_report patches, `"chat item"` appends events, `"tag"` upserts `session_tags`, `"evaluation"` inserts `session_external_evals`, `"outcome"` upserts `session_outcomes`. The `traces` and `metrics` OTLP routes return 200 without persisting (per-turn agent metrics ride on the recording's `chat_history` payload, not OTLP metrics).

## Dashboard API

- `GET /api/sessions?limit=20&offset=0` — List sessions (paginated; `limit` clamps to [1, 50], default 20, optional `account_id` filter). Returns `{ objects, meta: { total_count, limit, offset, next, previous } }`.
- `GET /api/sessions/:id` — Session detail: includes `chat_history`, `session_metrics` (computed on the fly from raw data), `raw_report`, `events`, `options`.
- `DELETE /api/sessions` — Bulk delete. JSON body `{ session_ids: string[] }`, max 200 ids. Returns `{ deleted: <count> }`. Mirror endpoint `DELETE /api/evals` accepts `{ run_ids: string[] }` (UUID format) and cascades to `eval_cases`.

### Filter semantics

- Free-text filters (`account_id` on sessions; `account_id` and `agent_id` on evals) match via `LOWER(col) LIKE '%lower(input)%'` — case-insensitive substring. User input is escaped for `%` / `_` / `\` before being wrapped in wildcards. The wrap defeats the existing btree index and falls back to a sequential scan; acceptable at current row counts. If filter latency becomes a bottleneck, add a `pg_trgm` GIN index on `LOWER(col)` rather than dialing the match back to exact equality.
- Multi-value filters (`transport`, `framework`, `testing_framework`) stay strict via `IN (…)` since they're enum picks from a fixed option list.

## Migrations

SQL files in `migrations/` folder, named `001_description.sql`, `002_description.sql`, etc. Applied automatically on startup when `AUTO_MIGRATE=true`. Tracked in `_migrations` table.

## Environment Variables

See `.env.example` for all variables. Only `DATABASE_URL` is required. Basic auth (`AGENT_OBSERVABILITY_USER`/`_PASS`), LiveKit Bearer auth (`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`), and S3 upload (`S3_BUCKET` + credentials) are all opt-in — both env vars in each pair must be set to enable that feature. Either auth mode is sufficient on its own; configure both during a migration window if you have mixed clients.

## QA platform: Simulate · Live · Library · Schedules  (in progress — keep this current)

> **Direction:** per the integration plan (Desktop `integration-plan-v4.pdf` — "agent-observability *is* the product"), Truman + Voice Agent Doctor are being merged in. Keep the two execution models **distinct**: **VAD = text simulation (Simulate); Truman = live calling (Live).** When building anything on the Live/calling side, consult the `truman-reference` subagent for ground truth first — the model was rebuilt twice for getting this wrong.

**Frontend sections** (nav wired in `frontend/src/App.tsx`): Monitor (sessions, original) · Simulate · Live · Evals · Library · Schedules. Modules live under `frontend/src/components/{simulate,live,library,schedules}/`; the API client + result types are in `frontend/src/components/simulate/sim-data.ts`.

### Simulate — VAD model (`src/simulation/`)
Text simulation: paste a prompt / YAML / saved scenario → run N personas in parallel → report. Persists as an `eval_run` (`testing_framework = "simulation"`).
- **Run mode** (`text` / `voice` / `text_then_voice`). `text` = the persona text sim (runs here). **`voice` and `text_then_voice` no longer run real calls inside Simulate — they hand off to the Live tab** (real calls belong to the Live/Truman model; keeping them in Simulate duplicated Live's call path and felt inconsistent). Picking **voice** + Run (a phone number is required, so the button is disabled until it's entered) `navigate('/live', { state: { voiceFromSimulate: {prompt, personas, criteria, phoneNumber, rubricId, rubricName} } })`; the Live page's hand-off effect prefills its form, **auto-places** the suite (`placeCallBatch`), scrubs the nav state (so a refresh doesn't re-dial — the suite rehydrates via `ao.live.run` instead), and the user gets Live's full in-call experience (streaming transcript, audio, takeover). **`text_then_voice`** runs the text sim here, then the report shows an **"Escalate to Live calls"** button that hands the *failed* personas to Live the same way. The old inline `voice-suite-report.tsx` is no longer wired in. The voice/text_then_voice options stay visible in the mode selector — only their execution moved to Live.
- **Cancel:** the running phase has a **Cancel simulation** button wired to an `AbortController` (`runSimulation(req, signal)`), so a user can bail mid-diagnostic; the `AbortError` is swallowed and the saved handle cleared.
- `engine.ts` — `runSimulation` (batch personas), `generatePersonas` (AI-tailored, preview-then-approve), the persona catalog, YAML scenario parsing (resolves personas + rubric by id/name + threshold), LLM-or-demo gated on `SIM_LLM_API_KEY` (demo is prompt-derived and clearly labelled — fixes the old "always Pluto Pizza" bug).
- `routes.ts` — `POST /api/simulations`, `POST /api/personas/generate`.
- The **leveled judge** (flow→agent→task→node) is a deliberate VAD/senior-requested enhancement, **NOT** Truman.
- **Judging now runs through LiveKit's eval judges.** When `trumanEnabled` + a criteria rubric is present, Simulate sends the generated transcript + criteria to Truman's `POST /v1/judge` (`truman.ts judgeTranscript`), which runs `livekit.agents.evals` (`_LLMJudge` per criterion over a `ChatContext`, Azure LLM) → per-criterion verdict on `SimCaseResult.judge` (status/score derived from it). The Live caller's post-call eval uses the same `core.livekit_judge` (`apps/caller/eval.py`). One judge engine for Simulate + Live. Generation (demo/SIM_LLM/real call) is independent of judging.

### Live — Truman model (`src/simulation/engine.ts` `runCall`)
A **suite** of calls (one per persona) against an agent, scored by **criteria** (yes/no per criterion, `overall = all pass`), with the real call lifecycle (queued→dialing→live→recording→evaluating→done), dual audio legs, and **takeover ("director on stage")**.
- `routes.ts` — `POST /api/calls` (one call), `POST /api/calls/batch` (suite). Persists as `eval_run` (`testing_framework = "live-call"`).
- **Two modes, gated on `TRUMAN_API_URL` + `TRUMAN_API_TOKEN`** (see `trumanEnabled` in `config.ts`):
  - **Real (Truman)** — AO orchestrates Truman's API (LiveKit/PSTN can't run in Bun). `src/simulation/truman.ts` provisions Truman entities from the AO selections (`POST /v1/agents,personas,rubrics,scenarios`, deduped via `sim_truman_map`), creates a Truman **suite** (`POST /v1/suites`, one run per persona), and `src/simulation/live.ts` tracks it (`sim_live_suites`/`sim_live_calls`). The batch returns **async** (`{ suiteId, mode:'truman', status, calls:[queued] }`); the frontend polls `GET /api/calls/batch/:suiteId`, which pull-through-reconciles each Truman run and, once all terminal, persists one `live-call` eval run. A background `startLiveReconciler()` (10s tick, in `index.ts`) finishes/persists suites even with no client polling. **Truman judges** the real transcript against the rubric we push in; AO ingests its `judge_result` (same `{criteria,overall,notes}` shape). `GET /api/calls/audio/:runId` proxies the recording (keeps the Truman token server-side).
  - **Demo/LLM shell** — when Truman isn't configured: synchronous engine-driven calls (the old behavior), unchanged.
  - **Live in-call experience** (real mode): while a call is in progress AO streams Truman's live data into the Live UI — streaming transcript, listen-in audio (both legs), and **take-mic/director** controls + end-call. AO **WebSocket-proxies** Truman's per-run sockets (token stays server-side) via `src/simulation/ws.ts` (`createBunWebSocket`, mounted as `websocket` on the Bun default export): `GET /api/calls/:runId/{stream,audio,takeover/audio}` ↔ Truman `/v1/runs/{id}/{stream,audio,takeover/audio}`; control via `POST /api/calls/:runId/{takeover/start,takeover/stop,end-call}`. Frontend: `frontend/src/components/live/use-live-call.ts` + ported AudioWorklets `frontend/public/{pcm-player,mic-capture}-worklet.js` (8 kHz PCM). The Vite dev proxy needs `ws: true` on `/api`. Each call's `truman_run_id` is exposed on the `CallResult` so the UI knows which run to stream.
- **Real dialing additionally needs the caller worker running** (`bun run caller:worker`, now vendored in-repo — see "Vendored calling subsystem" below; legacy: `cd truman && uv run python -m caller.server`) + a public tunnel; with the worker off, provisioned runs queue but never dial (safe). On a preflight `/health` miss AO returns **502** (`truman_unavailable`) — it never fakes a result.
- **Mapping gotchas** (`truman.ts`): AO `prompt` (agent-under-test) → Truman Agent.description (Truman dials a real phone, can't inject the prompt); AO persona → Truman persona prompt; AO criteria `name` → Truman `key`. **Truman transcript roles are inverted** — persona/caller is `assistant`→AO `'user'`, callee-under-test is `user`→AO `'agent'`. **`transcript_text` is JSONL** (`{"role","text","ts"}` per line, the live transcript) — `parseTranscript` JSON-parses each line (and also handles diarized `speaker_N:` lines from a Deepgram recording). `usage` → `cost` (best-effort). Live audio + takeover **are** bridged (see the live in-call experience above).

### Vendored calling subsystem (`services/calling/` — no `~/truman` runtime dependency)
The Truman live-calling backend is **vendored into this repo** so AO no longer depends on the external `~/truman` checkout at runtime. It's a self-contained Python (`uv`) project at `services/calling/`; **AO's TypeScript backend is unchanged** and still talks to it over HTTP/Redis on `localhost` exactly as before (`TRUMAN_API_URL=http://localhost:9082`, same `TRUMAN_API_TOKEN`).
- **What it is:** Truman's `packages/core` + `apps/caller` + `apps/api` copied **verbatim** into one package `services/calling/src/truman_calling/{core,caller,api}`, with imports rewritten `core|caller|api` → `truman_calling.*` (147 lines, word-boundary-safe). Plus `alembic/` (9 migrations, head `b2d4e6f8a901`, seeds `DEFAULT_ORG`), `docker-compose.yml` (Postgres `:5532` + Redis `:6479`), `.env`/`.env.example`, README. NOT vendored: `apps/cli`, `apps/evals`, the web frontend.
- **Why AO calls all three (not just the caller):** AO's contract is against the **API** (`:9082` — suites, runs, judge, takeover, WS), not the caller (`:9081`/`:9766`, which only dials). So "the code AO depends on" is the union api+core+caller. Copied verbatim (not thin-rewritten) to avoid contract drift — an adversarial review confirmed **zero drift**: `POST /v1/suites`→`runs[].{id,scenario_id}`, `GET /v1/runs/{id}` status (`done`/`failed` terminal) + `judge_result {criteria,overall,notes}` + `usage.{llm,tts,stt,plivo}` + `transcript_text` JSONL + the `chat_history`/`session_metrics` ride-along, and the Redis channels (`truman:place_call`, `truman:run|audio|takeover:{id}`) all match what `truman.ts`/`live.ts`/`ws.ts` parse.
- **Run:** `bun run caller:infra` (docker PG+Redis), `caller:migrate` (alembic, from the checkout), `caller:api` (uvicorn `truman_calling.api.main:app` `:9082`), `caller:worker` (`python -m truman_calling.caller.server` `:9081`+`:9766`). The `:5532`/`:6479` containers are shared with Truman, but AO uses its **own database `ao_calling`** (create once: `CREATE DATABASE ao_calling OWNER truman;`) + Redis db **`/1`** — isolated from Truman's `truman` DB / `/0`, so AO's runs never appear in Truman and vice-versa. (Schema is identical — same alembic — just a separate database.) AO's own Postgres `:5432` is unrelated; the bun backend never connects to the calling DB, only the vendored api/caller do.
- **Gotchas:** pins are load-bearing — `agent-transport==0.1.11` (Rust `abi3` wheel; `audio_tap.py`/`takeover.py` patch its private internals), `livekit-agents~=1.5` (`core/livekit_judge.py` imports the **private** `livekit.agents.evals.judge._LLMJudge`), and `redis>=7.4,<8` (redis-py 8.x raises `TimeoutError` on a blocking `XREADGROUP BLOCK` that returns empty → silently kills the caller's `truman:place_call` consume loop; the worker logs "consuming…" then never dials — caught during cutover validation). Commit `services/calling/uv.lock`. **Only run `caller.server`, never `caller.worker` standalone** (server prewarm starts the queue consumer in-process; a second consumer double-acks). Run from the checkout, not a built wheel (alembic lives at the project root, not in the wheel). **If you change the calling `DATABASE_URL`** (e.g. switched to `ao_calling`), `TRUNCATE sim_truman_map` in AO's Postgres (`agent_observability`) — that table caches AO→Truman entity ids, and stale ids from the old DB make `POST /v1/suites` fail with `{"detail":"agent not found"}`; clearing it makes AO re-provision agents/personas/rubrics/scenarios into the new DB on the next call. Full setup/cutover/inherited-issues in `services/calling/README.md`.

### LiveKit-pytest evals (`truman/apps/evals` — code-authored / CI evals)
A pytest package in the **Truman** monorepo (new uv workspace member) that runs LiveKit-judge evals from code and ingests them here. Each test builds the agent-under-test as a LiveKit `Agent(instructions=<system_prompt>, llm=<azure>)`, drives it text-only via `await session.run(user_input=<persona line>, input_modality="text")` across N turns, then judges the cumulative `session.history` ChatContext with the **shared P0 `core.livekit_judge.judge_chat_ctx`** (one `_LLMJudge` per criterion) and `assert verdict["overall"] == "pass"`. Roles are already correct for the live ChatContext (persona via `user_input` → `user`; agent replies → `assistant`), so no `caller_labels`. The existing **`pytest-agent-observability`** plugin auto-captures every `AgentSession.run` RunResult (→ events) and, at `pytest_sessionfinish`, POSTs once to `{AGENT_OBSERVABILITY_URL}/observability/evals/v0`; the harness records each criterion verdict via `collector._record_judgment(intent,verdict,reasoning)`. Runs land in the **Evals tab tagged `framework=livekit` (auto-detected from installed `livekit-agents`) / `testing_framework=pytest`** with per-criterion judgments + the conversation. Reuse: `EvalSpec` + `run_eval` in `apps/evals/src/evals/harness.py`; example `tests/test_pluto_pizza.py`; saved-scenario→eval generator `evals/scenario_gen.py` (+ `scenarios/*.json`). Run: `AGENT_OBSERVABILITY_URL=http://localhost:9090 uv run --package evals pytest apps/evals/tests`. The plugin no-ops if `AGENT_OBSERVABILITY_URL` is unset; Azure creds come from `truman/.env` via `core.settings` (else the suite skips). The plugin is wired into the truman venv via a root-`pyproject` `[tool.uv.sources]` editable path into this repo's `plugins/pytest-agent-observability`.

### Call metrics → Monitor session (LiveKit performance metrics)
Every real Truman call materializes an AO **Monitor session** (`agent_transport_sessions`, `transport='phone'`) carrying the **caller agent's** real LiveKit per-turn metrics, so the existing Monitor → Performance tab renders TTFT / TTS latency / STT latency / turn-detection + interruptions for it. Flow:
- **Truman caller** (`apps/caller/src/caller/server.py`, `_persist_usage_on_close`): serializes `ctx.session.history.items` and rides `chat_history` + `session_metrics` into `runs.usage` via the **same** `merge_run_usage` write as cost (one write, no race, no new column/migration). Each `ChatMessage.metrics` (a LiveKit `MetricsReport`) already uses AO's exact field names **in seconds** (`llm_node_ttft`, `tts_node_ttfb`, `transcription_delay`, `end_of_turn_delay`, `e2e_latency`, `started/stopped_speaking_at`) + `interrupted` + `transcript_confidence` — so **no rename, no scaling**. (Per-turn token counts are omitted for now — they're not on `ChatMessage.metrics` and needed a fragile speech_id bridge.)
- **AO** (`src/simulation/truman.ts` `mapRun` exposes `sessionChatHistory`/`sessionMetrics` off `run.usage`; `buildMonitorChatHistory` normalizes — **no role inversion**, because the metrics ARE the caller agent's so the session represents the caller agent: `user` items carry STT/EOU, `assistant` items carry LLM/TTS, exactly what `metrics.ts` expects). `src/simulation/live.ts` `reconcileSuite` creates the session via `insertSession` when a call goes terminal (best-effort, idempotent on `sim_live_calls.session_id`) and links it. Migration **019** adds `sim_live_calls.session_id`.
- **Frontend**: `metrics.ts` summary now also computes `avg/p95_turn_decision_ms` + `interruption_rate`; `metric-summary-cards.tsx` shows a **Turn Detection** tile + a **Barge-in** tile (count + rate); the Live call's done-footer has an **"Open Monitor session (metrics)"** button → `/sessions/:id`. (`observability-types.ts` MetricsSummary gained the 3 fields; mirror in `packages/ui/registry` updated — `public/r` needs a `shadcn build` regen at publish time.)
- **Semantic caveat:** these latencies are the **caller agent's** pipeline (the synthetic persona's Azure LLM / ElevenLabs TTS / Deepgram STT-of-the-callee), NOT the dialed agent-under-test (a black box over PSTN). Text sims have no audio → audio metrics are N/A (LLM-only, planned next). The qualitative **wrong-barge-in judge** is deferred to a separate non-verdict-gating pass (adding it to the main rubric judge would flip `overall=all-pass`).

### Refresh persistence (Simulate + Live)
In-progress/just-finished runs survive a browser refresh via `frontend/src/components/simulate/run-persistence.ts` (no backend change). The only server-recoverable handle is the Truman **`suiteId`** (re-fetched with `getSuiteStatus` → `GET /api/calls/batch/:suiteId`); both pages persist a small localStorage blob (`ao.live.run` / `ao.sim.run`, version-stamped) on start and **rehydrate on mount** — set `batch`/`voiceSuite` + `phase` and the existing poll effects + `useLiveCall` resume on their own. The handle is cleared on terminal/`New suite`/`New simulation` (so a finished suite doesn't auto-reopen) and on a 404 re-fetch. The **Live elapsed timer** is seeded from a persisted `startedAt` (the `clock` counter otherwise restarts at 0). The **synchronous text sim** has no server handle: its finished `SimResult` is snapshotted into the blob (server keeps none); if interrupted mid-flight it offers a one-click **Re-run** rather than faking a recovered run. A fresh Library→Scenario navigation (`location.state.scenario`) wins over a saved blob.

### Library (`src/simulation/library.ts`)
Postgres CRUD: `/api/library/{personas,rubrics,scenarios,agents}`. Built-in rows are protected (no edit/delete). Define + Live load personas/rubrics from here; generated personas can be saved; scenarios are runnable (their YAML drives the run).
- **Rubrics are criteria-based** (Truman model): a rubric is a list of `criteria: [{ name, question, weight? }]` — each a yes/no check the judge answers (`overall = all pass`). The legacy weighted-`axes` column is kept for back-compat (Simulate still derives axis scores from criteria `name` + `weight`); `engine.ts` resolves criteria with an axes fallback. Migration 015 backfills criteria from axes; the builtin 7-axis rubric is reseeded with 7 real yes/no questions.
- **Agents** are a first-class entity (`sim_agents`: name, phone_number, description, system_prompt). The Live page's agent picker fills the prompt + phone from a saved agent; built-in `pluto-pizza` seeded.

### Schedules (`src/simulation/schedules.ts`)
`/api/schedules` CRUD + a background scheduler (`startScheduler`, 30s tick) that runs due scenarios, persists each as an eval run, and records `/api/alerts` when pass-rate drops below a threshold (+ optional Slack webhook).

### persist.ts
Maps sim/call results → `EvalPayloadV0` → `insertEvalRun` (best-effort) so all runs surface in Evals.

### New migrations
- `013_create_sim_library.sql` — `sim_personas`, `sim_rubrics`, `sim_scenarios` (seeds 6 built-in personas + the default 7-axis rubric).
- `014_create_schedules.sql` — `sim_schedules`, `sim_alerts`.
- `015_add_rubric_criteria.sql` — adds `criteria JSONB` to `sim_rubrics`, backfills from `axes`, reseeds the builtin 7-axis rubric. **Guard the backfill on `jsonb_typeof(axes) = 'array'` only** — `jsonb_array_length(axes)` in the WHERE throws on scalar/null rows (AND does not short-circuit) and crashes boot.
- `016_create_sim_agents.sql` — `sim_agents` + seeds builtin `pluto-pizza`.
- `017_repair_rubric_jsonb.sql` — un-double-encodes string-scalar `criteria`/`axes` (`(col #>> '{}')::jsonb`) left by the old write path, then re-runs the 015 backfill for rows whose axes was a string scalar at 015 time (e.g. "Safety & guardrails", which had 0 criteria until this ran).
- `018_create_live_calls.sql` — `sim_truman_map` (AO→Truman entity dedup), `sim_live_suites`, `sim_live_calls` (real Live call orchestration).

### New env (optional)
- **Simulation LLM (generation):** `SIM_LLM_API_KEY` (OpenAI-compatible) · `SIM_LLM_BASE_URL` · `SIM_LLM_MODEL`. **Or Azure** (same account Truman uses): `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` (+ `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT` default `gpt-4.1-mini`) → `engine.ts chat()` uses the Azure deployment URL + `api-key` header. When either is set, Simulate generates real persona↔agent conversations (`engine:"llm"`, no demo note); unset → prompt-derived demo. **Generation (this) is separate from judging (LiveKit via `/v1/judge`).**
- **Truman caller (real Live calls):** `TRUMAN_API_URL` + `TRUMAN_API_TOKEN` → Live places real calls via Truman (else demo shell). `TRUMAN_JUDGE_MODEL` (default `gpt-4.1-mini`) · `TRUMAN_DEFAULT_VOICE_ID` (empty → Truman's configured voice). Real dialing also needs Truman's caller worker + a public tunnel.

### Local full-stack run
```bash
docker compose up postgres -d
DATABASE_URL="postgres://observability:observability@localhost:5432/agent_observability" AUTO_MIGRATE=true PORT=9090 bun run dev   # backend :9090
cd frontend && bun run dev                       # vite :5173 (falls back to :5174 if taken), proxies /api → :9090
cd frontend && bunx tsc --noEmit -p tsconfig.app.json   # typecheck (noUnusedLocals is on)
```

### Gotchas (learned the hard way — do not re-hit)
- **`bun --hot` does NOT register newly-added routes / new module imports — restart the backend** after adding routes (else the route 404s).
- **Primary `<Button>` text vanishes on the dark surface:** tailwind-merge drops `text-primary-foreground` because the shadcn Button's custom size token (`text-s-500`/`text-xs-500`) isn't recognized as a font-size and is treated as a color. Fix: inline `style={{ color: 'hsl(var(--primary-foreground))' }}` (the `PRIMARY_FG` const).
- **Bun arrays don't bind in `` sql`` ``** → use `sql.unsafe` with positional `$n` placeholders.
- **Writing jsonb: pass the JS value straight into `` `${value}::jsonb` ``, do NOT `JSON.stringify` it first.** `${JSON.stringify(x)}::jsonb` double-encodes — bun:sql stores it as a jsonb **string scalar** (`"[{…}]"`) instead of an array/object. Read paths that do `parseJson` mask it, so it looks fine via the API, but raw jsonb operators (`jsonb_array_elements`, `jsonb_array_length`, `->`) then throw "cannot get array length of a scalar". This is a latent pattern across the codebase (e.g. `src/evals/db.ts` stores `events`/`judgments`/`ci` as string scalars — works only because every reader re-parses). New jsonb writes should use the array-direct form; repair legacy string scalars with `(col #>> '{}')::jsonb`.
- Ingest/persistence is **fire-and-forget** — a DB error must never fail the primary request.
- **Never edit an applied migration** — add a new numbered file. SQL seed strings must avoid/escape apostrophes.
- The demo schedule (if one exists) fires ~every 1 min — pause/delete it to stop the churn.
- **Live (criteria) looks like "all failed" while Simulate passes some — by design of two different pass rules, made worse by the demo judge.** Live uses Truman semantics: `overall = EVERY criterion passes`. Simulate uses `score ≥ threshold` per persona (lenient). In demo mode (no `SIM_LLM_API_KEY`) `judgeCriteria` (`engine.ts`) can't read the transcript, so it derives each criterion from **persona quality vs. a two-band difficulty** (general criteria low bar, guardrail-type criteria — `policy/safety/inject/halluc/data/refus/guard/verif` — high bar). Tuned so baseline/knowledge personas pass and adversarial personas fail the guardrail criteria. The earlier heuristic auto-failed ALL guardrail criteria on any flagged turn → near-deterministic all-fail; don't reintroduce that. Real judging (LLM key set) reads the transcript and is unaffected.

### Subagents (`~/.claude/agents/`)
`truman-reference` (Truman ground truth, read-only) · `ao-frontend` · `ao-backend` · `verifier` · `code-reviewer` · `plan-keeper`.

### Docs
Codebase walkthroughs + animations in `docs/` (open `docs/index.html`). Integration plans on the Desktop (`integration-plans-index.html`; `integration-plan-v4.pdf` is current).

## Releasing

Three independently versioned packages publish from this repo, each via a
PR-label trigger — no manual tags or releases needed. The three publish
workflows (`publish-ui.yml`, `publish-pytest-plugin.yml`,
`publish-vitest-plugin.yml`) all hang off the `Tests` workflow's
`workflow_run` and fire only when a specific `release-*` label is
present on the merged PR.

### Packages at a glance

| Package | Source | Registry | Tag prefix | Trigger label | Notes filter label |
|---|---|---|---|---|---|
| `agent-observability-ui` | `packages/ui/` | npm | `ui-v*` | `release-ui-pkg` | `agent-observability-ui` |
| `pytest-agent-observability` | `plugins/pytest-agent-observability/` | PyPI | `pytest-plugin-v*` | `release-pytest-plugin` | `pytest-agent-observability` |
| `vitest-agent-observability` | `plugins/vitest-agent-observability/` | npm | `vitest-plugin-v*` | `release-vitest-plugin` | `vitest-agent-observability` |

### Release flow (same for all three)

1. Bump `version` in the package's manifest
   (`packages/ui/package.json` / `plugins/pytest-agent-observability/pyproject.toml` /
   `plugins/vitest-agent-observability/package.json`).
2. **Version bumps must be in a dedicated PR** — do not mix with
   feature changes.
3. Labels:
   - `release-*` (from the table above) — apply to the version-bump PR
     to trigger the publish.
   - Per-package notes filter (from the table above) — apply to
     feature/fix PRs you want listed in that package's next release
     notes. The three packages are independent and share no source
     code, so a PR almost always targets exactly one of them; if a PR
     somehow touches two, apply both labels.
4. Merge to `main`. `Tests` runs; on success, the matching publish
   workflow picks up the merged commit, builds + publishes the package,
   and creates a `<prefix>-v<version>` GitHub Release with notes listing
   every labeled PR merged since the previous tag of the same prefix.

### Registry JSON (UI package only)

The registry JSON under `packages/ui/public/r/` is served from git via
`raw.githubusercontent.com` — it is **not** shipped in the npm tarball.
If you add or change a registry item in `registry.json`, run
`cd packages/ui && bun run build` and commit the regenerated
`public/r/*.json` files in the same PR.

### Prerequisites (one-time setup)

- **npm:** `NPM_TOKEN` must be set as a repository Actions secret (an npm
  automation token with publish rights for both `agent-observability-ui`
  and `vitest-agent-observability`).
- **PyPI:** configure a trusted publisher at pypi.org for
  `pytest-agent-observability` pointing at the
  `publish-pytest-plugin.yml` workflow in this repo. No secret needed.
- **GitHub labels:** create each label in the table above in the repo.

### Labeling PRs (agents creating PRs in this repo)

When an agent (or a human contributor) opens a PR against this repo,
apply the notes-filter labels that match which packages the change
touches. Release note generation is entirely label-driven — a PR
without any notes-filter label will not appear in any release notes,
even if it's merged into main.

Path-to-label cheat sheet — apply every label whose path prefix the PR
modifies:

| Paths touched | Apply label |
|---|---|
| `packages/ui/**` | `agent-observability-ui` |
| `plugins/pytest-agent-observability/**` | `pytest-agent-observability` |
| `plugins/vitest-agent-observability/**` | `vitest-agent-observability` |
| `src/**`, `migrations/**`, `frontend/**`, or any other path outside `packages/ui/**` and `plugins/**` | no notes-filter label needed — those paths aren't published as a package |
| Version bump only, in `packages/ui/package.json` | `release-ui-pkg` (no notes-filter label — bumps are not in release notes) |
| Version bump only, in `plugins/pytest-agent-observability/pyproject.toml` | `release-pytest-plugin` |
| Version bump only, in `plugins/vitest-agent-observability/package.json` | `release-vitest-plugin` |

Rules:
- The three publishable packages share no source code; a PR almost
  always targets exactly one of them and carries one notes-filter
  label. The rare cross-cutting PR can carry multiple labels.
- `release-*` trigger labels are mutually exclusive with notes-filter
  labels *on the same PR*. A version-bump PR has exactly one
  `release-*` label and nothing else — notes come from the feature PRs
  merged since the previous tag.
- Apply labels with `gh pr edit <n> --add-label <label>`. If the token
  available in the current session lacks `issues: write` permission
  on the repo, the command fails with a 403 — in that case, list the
  labels-you-would-apply in the PR description so a maintainer can add
  them manually, and move on. Do not block the PR on it.
