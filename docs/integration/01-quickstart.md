# Quickstart — adopt AO in 15 minutes

Goal: stand up Agent Observability, point one agent at it, and see your first
call appear in **Monitor**. No code changes to AO required.

**Prerequisites**
- Docker (with Compose), or [Bun](https://bun.sh) + a Postgres database
- A voice agent built on [agent-transport](https://github.com/plivo-labs/agent-transport) (for the Monitor step)

---

## Step 1 — Run AO

The fastest path is Docker Compose. It builds the dashboard, starts Postgres,
runs migrations, and serves the API + UI on **http://localhost:9090**.

```bash
git clone https://github.com/plivo-labs/agent-observability
cd agent-observability
cp .env.example .env
docker compose up --build
```

The compose file points `DATABASE_URL` at the bundled Postgres and sets
`AUTO_MIGRATE=true`, so the schema is created on first boot. You only need to
edit `.env` to turn on optional features (auth, S3 recordings, the simulation
LLM) — see [Auth & deployment](./06-auth-and-deployment.md).

> **Local dev instead of Docker?** `bun install`, set `DATABASE_URL` in `.env`,
> then `bun run dev` (backend :9090) and `bun run dev:frontend` (dashboard
> :5173). See the repo `README.md`.

## Step 2 — Verify it's up

```bash
curl http://localhost:9090/health
# {"status":"ok","s3Enabled":false}
```

Open **http://localhost:9090** in a browser. You'll see the dashboard with its
sections: **Monitor · Simulate · Live · Evals · Library · Schedules**. They're
empty until data arrives — that's the next step.

## Step 3 — Send your first call (Monitor)

In your **agent process**, set where to upload session reports and how to
authenticate. The simplest local setup (no auth):

```bash
# In the agent process environment
AGENT_OBSERVABILITY_URL=http://localhost:9090
```

Place (or simulate) one call through your agent. When the call ends,
agent-transport POSTs a session report to AO. Refresh **Monitor** — the call
appears with its transcript, per-turn latency, and (if configured) audio.

For production — with auth, multi-tenant `account_id`, and OTLP details — read
**[Send your agent's telemetry](./02-send-telemetry.md)**.

## Step 4 — Try QA without any agent wiring

You don't need a live agent to try the QA side:

- **Simulate** → paste your agent's system prompt → Run. AO generates personas,
  runs text conversations against the prompt, and scores them with the LLM judge.
  *(Real LLM output requires `SIM_LLM_*` or `AZURE_OPENAI_*` in `.env`; otherwise
  you get clearly-labelled demo data.)*
- **Live** → place a real phone call per persona and score it. *(Requires the
  calling subsystem + telephony creds — see guide 04.)*

---

## Where to go next

| You want to… | Guide |
|---|---|
| Monitor production calls properly (auth, tenancy) | [02 — Send your agent's telemetry](./02-send-telemetry.md) |
| Gate releases on agent quality in CI | 03 — Run evals in CI *(planned)* |
| QA an agent before launch | 04 — Run a simulation or live call *(planned)* |
| Embed AO's views in your own product | 05 — Embed AO *(planned)* |
| Deploy AO securely | 06 — Auth & deployment *(planned)* |
| Call AO's API directly | 07 — API reference *(planned)* |

## Troubleshooting

- **`/health` doesn't respond** → container still building, or `:9090` is taken
  (set `PORT` in `.env`).
- **Boot fails with a Postgres error** → `DATABASE_URL` is wrong or Postgres
  isn't reachable. With Docker Compose this is wired for you; for local dev make
  sure your database is running.
- **Dashboard loads but stays empty** → no data yet. Send a call (Step 3) or run
  a Simulate diagnostic (Step 4).
