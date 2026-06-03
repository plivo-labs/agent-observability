# `services/calling` — vendored Truman live-caller

This is the **live-calling subsystem** that agent-observability's **Live** tab
orchestrates, vendored into this repo so AO has **no runtime dependency on the
external `~/truman` checkout**. It is a self-contained Python (`uv`) project; AO's
TypeScript backend is unchanged and still talks to it over HTTP/Redis on
`localhost`, exactly as before.

It is a verbatim copy of three Truman packages, collapsed into one importable
package `truman_calling`, with imports rewritten `core|caller|api` →
`truman_calling.{core,caller,api}`:

| Vendored from (Truman) | Here | Role |
|---|---|---|
| `packages/core` | `src/truman_calling/core` | models, settings, Redis queue, `livekit_judge`, pricing |
| `apps/caller` | `src/truman_calling/caller` | LiveKit voice worker: Plivo dial, persona session, audio tap, takeover |
| `apps/api` | `src/truman_calling/api` | FastAPI `/v1/*` + WS app AO calls (`:9082`) |
| `alembic/` + `alembic.ini` | `alembic/` + `alembic.ini` | 9 migrations (head `b2d4e6f8a901`), seeds `DEFAULT_ORG` |

Not vendored: Truman's `apps/cli`, `apps/evals`, the web frontend.

## Architecture (unchanged from Truman)

```
AO backend (bun, :9090)
  └─ HTTP/WS → truman_calling.api  (uvicorn, :9082)   ← TRUMAN_API_URL
       ├─ Postgres :5532 (db truman, alembic schema)
       └─ Redis :6479
            ├─ Stream  truman:place_call         → caller worker dials
            └─ pubsub  truman:run|audio|takeover:{id}  → AO WS bridge
truman_calling.caller  (python -m …caller.server, :9081 HTTP + :9766 media WS)
  └─ Plivo PSTN ↔ public tunnels (PUBLIC_BASE_URL→:9081, PUBLIC_WS_BASE_URL→:9766)
```

## One-time setup

```bash
# from the AO repo root:
cp services/calling/.env.example services/calling/.env   # then fill in secrets
#   - TRUMAN_API_TOKEN must EQUAL AO's TRUMAN_API_TOKEN
#   - DATABASE_URL → ao_calling (AO's own DB), REDIS_URL → /1 (isolated from Truman)
#   - Plivo / Deepgram (VPN host) / ElevenLabs / Azure keys
#   - PUBLIC_BASE_URL / PUBLIC_WS_BASE_URL → your tunnels

bun run caller:infra      # docker compose up -d  (Postgres :5532 + Redis :6479)
# Create AO's OWN database on that server (one-time) — isolated from Truman's `truman` DB:
docker exec truman-postgres psql -U truman -d postgres -c "CREATE DATABASE ao_calling OWNER truman;"
cd services/calling && uv sync && cd -   # install deps (pulls agent-transport wheel + livekit)
bun run caller:migrate    # alembic upgrade head on ao_calling (creates schema + seeds DEFAULT_ORG)
```

## Run (dev)

Three processes alongside AO's `bun run dev`:

```bash
bun run caller:api        # uvicorn truman_calling.api.main:app  :9082
bun run caller:worker     # python -m truman_calling.caller.server  :9081 + :9766
# AO already points at it:  TRUMAN_API_URL=http://localhost:9082
```

For **real PSTN dials** you also need the two public tunnels up (HTTPS→:9081,
WSS→:9766) and `PUBLIC_BASE_URL`/`PUBLIC_WS_BASE_URL` in `.env` set to them —
unchanged operational prereq, plus the Plivo IP whitelist and (self-hosted)
Deepgram reachable over VPN.

## Cutover from `~/truman`

This service replaces the `~/truman` API + caller processes. To switch:
1. Stop the old Truman processes (`pkill -f "caller.server"`, stop its uvicorn).
2. Start `bun run caller:api` + `bun run caller:worker` here.
3. AO's `.env` is unchanged (`TRUMAN_API_URL=http://localhost:9082`).

Independence proof: `mv ~/truman ~/truman.bak`, then the three commands above +
an AO Live suite still work — nothing here reads from `~/truman`.

## Gotchas (do not re-hit)

- **Only run `caller.server`, never `caller.worker` standalone.** `server.run()`
  starts the `truman:place_call` consumer **in-process** via prewarm; a second
  standalone worker double-consumes the stream.
- **Pins are load-bearing.** `agent-transport==0.1.11` (a prebuilt Rust `abi3`
  wheel — `caller/audio_tap.py` + `caller/takeover.py` reach into its private
  internals) and `livekit-agents~=1.5` (`core/livekit_judge.py` imports the
  **private** `livekit.agents.evals.judge._LLMJudge`). Commit `uv.lock`; a minor
  bump can break either. The judge backs both `POST /v1/judge` and post-call eval.
  Also **`redis>=7.4,<8`**: redis-py 8.x raises `TimeoutError` on a blocking
  `XREADGROUP BLOCK` that returns nothing, which silently kills the caller's
  `truman:place_call` consume loop (the worker logs "consuming…" then never
  dials). Truman runs 7.4.x — stay on that major. Caught during cutover validation.
- **Own database, isolated from Truman.** AO's calling uses a dedicated
  `ao_calling` database (and Redis db `/1`) on the same Postgres `:5532` / Redis
  `:6479` containers as Truman — but a *separate* database, so AO's runs never
  appear in Truman's `truman` DB and vice-versa. (Both share the `docker-compose`
  containers; the data is split by database, not by server.) Ports are
  non-standard: `:5532` (not AO's `:5432`) and `:6479` (not `6379`). AO's bun
  backend never connects to either — only this service does, over `localhost`.
- **Co-location is required for recordings.** Two distinct artifacts: the
  audio-stream **OGG** the proxy serves (`GET /v1/runs/{id}/audio.ogg`) is written
  by `agent-transport` to `/tmp/agent-sessions/recording_{session_id}.ogg` —
  **host-local and ephemeral** (it's in `/tmp`); the post-call **Plivo WAV** is
  downloaded during the eval pipeline under `data/recordings/`. Run `api` and
  `caller` on the **same host** so the proxy can read the OGG the caller wrote. A
  real S3/GCS deploy needs both paths externalized.
- **`.env` placement anchors the project root.** `settings._find_project_root()`
  walks up for `.env`/`.env.example`; keeping both in `services/calling/` makes
  it resolve here, not at the AO repo root (which also has a `.env.example`).
- **`HTTP_PORT=9081`** must be set in `.env` — `caller/config.py` defaults to
  `9080`, but the tunnels + Plivo answer URL assume `:9081`.

## Deploy model + known inherited issues

**Run from this checkout, not a built wheel.** The `pyproject` wheel only ships
`src/truman_calling`; `alembic/` + `alembic.ini` live at the project root (they're
operational assets), so `bun run caller:migrate` is run from the repo, never from
a `pip install`-ed wheel. A wheel-only container would import fine but couldn't
create its schema.

These behaviors are copied **verbatim from Truman** (identical in the upstream
service) — left unchanged to keep the copy faithful and re-syncable, but worth
knowing:
- `caller/config.py` creates `data/{recordings,transcripts,evals}` at **import
  time** and resolves the project root by walking up for `.env`/`.env.example`. In
  a wheel install with no `.env` on the path this resolves under `site-packages` —
  fine here (we run from the checkout with `.env` present), but set
  `RECORDINGS_DIR`/`TRANSCRIPTS_DIR`/`EVALS_DIR` explicitly for any container deploy.
- `run_orchestrator.merge_run_usage` is a read-modify-write on `runs.usage` JSONB
  without a row lock; it's called twice per call (early `session_id`, then the
  cost + `chat_history`/`session_metrics` ride-along at close). A future third
  concurrent writer could race. Make it atomic (`usage = COALESCE(usage,'{}') ||
  :patch::jsonb`) if it ever drops data — but it's pre-existing, not a vendoring
  regression.
