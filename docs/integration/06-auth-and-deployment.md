# Auth & deployment

How to run AO securely and put it somewhere your agents and team can reach it.

## Authentication model

AO has two independent auth mechanisms; both are **opt-in** (each needs its env
pair set), and either is sufficient on its own.

| Mode | Env (both required) | Covers |
|---|---|---|
| **Basic** | `AGENT_OBSERVABILITY_USER` + `AGENT_OBSERVABILITY_PASS` | All `/api/*` and ingest routes (everything except `/health`) |
| **LiveKit Bearer JWT** | `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` | The native **ingest** routes (recordings + OTLP) |

- With **neither** set, AO runs **open** — acceptable only on localhost or a
  private network. Never expose an open instance to the internet.
- With Basic set, the dashboard `/api` is protected. (Today the dashboard `/api`
  is Basic-only; a token path for cross-origin embedding is on the roadmap — see
  guide 05.)
- See [Send your agent's telemetry](./02-send-telemetry.md) for matching the
  credential on the agent side and for generating the LiveKit keypair.

> **Auth must match on both sides.** AO verifies what the client sends; the
> agent (and the pytest/vitest plugins) must present the same Basic creds or be
> signed with the same LiveKit keypair.

## Deploying AO

AO is a single service: one process serves the API **and** the built dashboard
on one port.

### Option A — Docker Compose (recommended)

Builds the frontend, starts Postgres, runs migrations, serves on `:9090`.

```bash
cp .env.example .env      # set auth + any optional features
docker compose up --build
```

### Option B — Bun, manual

```bash
bun install
bun run build:frontend    # produces frontend/dist
bun run start             # serves API + static dashboard on $PORT (default 9090)
```

Set these in production:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | **Required.** Postgres connection string. |
| `AUTO_MIGRATE` | `true` to apply SQL migrations on startup. |
| `PORT` | Listen port (default `9090`). |
| auth vars | As above — don't run open in production. |

Put it behind your normal ingress/TLS. CORS is enabled on `/api/*`, so a browser
on another origin can call the API (subject to auth).

## Recording storage (S3)

By default audio lives with the session record. For durable, signed-URL audio,
configure S3 (or an S3-compatible store) on AO:

```bash
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=               # set for S3-compatible providers
S3_PREFIX=recordings
```

> **Security note:** recording playback proxies only an allowlisted bucket
> (`plivocloud`). If you point `S3_BUCKET` elsewhere, audio writes succeed but
> the player won't proxy a non-allowlisted bucket — adjust the allowlist
> deliberately rather than widening it by accident.

## QA features in production

These are optional and only enable their tab's real behavior when set:

| Feature | Env | Effect |
|---|---|---|
| Simulate (real output) | `SIM_LLM_*` **or** `AZURE_OPENAI_*` | Real persona conversations + LLM judge (else demo) |
| Live (real calls) | `TRUMAN_API_URL` + `TRUMAN_API_TOKEN` | Real dialing via the calling subsystem (else demo shell) |

Live additionally needs the calling subsystem running and telephony
reachability — see [guide 04](./04-run-a-simulation-or-live-call.md) and
[`services/calling/README.md`](../../services/calling/README.md).

## Operational notes

- **Migrations** run on boot with `AUTO_MIGRATE=true`; they're tracked in a
  `_migrations` table and are idempotent. Never edit an applied migration — add
  a new numbered file.
- **Ingest is fire-and-forget** — a storage hiccup never fails the agent's
  primary request, but it can drop a report. Monitor your AO logs.
- **Schedules** (recurring sims + alerts) run on a background ticker inside the
  same process; a demo schedule, if present, fires ~every minute — pause or
  delete it to stop churn.
- **Rotating the LiveKit keypair** is a coordinated redeploy of agents (the SDK
  re-signs) and AO (it re-verifies) within one window.

---

Next: **07 — API reference** to build against AO directly.
