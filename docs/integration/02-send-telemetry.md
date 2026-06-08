# Send your agent's telemetry

This is the **Monitor** integration: get your voice agent's calls flowing into
AO so you can see transcripts, per-turn latency, audio, tags, and outcomes. It's
configuration only — no code changes on either side.

## How it works

When a call ends, the [agent-transport](https://github.com/plivo-labs/agent-transport)
SDK in your agent uploads a **session report** to AO:

- **Chat transcript** — full conversation with per-turn metrics (e2e latency,
  TTS TTFB, LLM TTFT, STT delay)
- **Audio recording** — OGG/Opus (optional)
- **Session metadata** — session ID, start time, duration, `account_id`

LiveKit-native agents additionally stream **OTLP log records** (tags, judge
evaluations, outcomes, session-report patches) as the call progresses. AO
persists all of it and renders it in Monitor.

## The one thing you set

In your **agent process**, point it at AO and choose an auth mode:

```bash
AGENT_OBSERVABILITY_URL=https://your-ao-host:9090
```

That URL is the only required setting. Everything else is auth (below).

## Authentication — pick one (or both)

AO accepts **either** auth mode on its own. The credential you set on the agent
must match what AO is configured with.

### Option A — Basic auth (simplest)

Set the same user/pass on **both** sides.

```bash
# On the agent process
AGENT_OBSERVABILITY_URL=https://your-ao-host:9090
AGENT_OBSERVABILITY_USER=your_user
AGENT_OBSERVABILITY_PASS=your_pass

# On the AO server (.env)
AGENT_OBSERVABILITY_USER=your_user
AGENT_OBSERVABILITY_PASS=your_pass
```

When both AO env vars are set, AO requires these credentials on all ingest and
`/api` routes (everything except `/health`).

### Option B — LiveKit-native Bearer JWT (agent-transport ≥ 0.1.10)

The LiveKit SDK signs every payload it emits with an HS256 keypair, and AO
verifies against the same pair. The keypair is **not** issued by a cloud
service — you generate it once and configure it on both sides:

```bash
# Generate once (any source of cryptographic randomness works)
LIVEKIT_API_KEY="API$(openssl rand -hex 6)"      # short identifier
LIVEKIT_API_SECRET="$(openssl rand -base64 48)"   # HS256 signing secret
```

Set the same pair on the agent (the SDK signs with it) and on the AO server
(`.env` — AO verifies with it). The JWT's `iss` claim must equal the key, and
its payload must carry `observability.write === true` (the SDK does this for
you). Rotating the pair is a coordinated redeploy of both sides within one
window.

> **Mixed fleet / migration?** Set both modes on AO. It accepts whichever header
> a given client sends.

> **Local / trusted network?** Leave all four auth vars unset on AO and it runs
> open — fine for localhost, not for anything reachable. See
> [Auth & deployment](./06-auth-and-deployment.md).

## Ingest endpoints (reference)

You normally don't call these directly — agent-transport does — but for
debugging or a custom client:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness — always unauthenticated |
| `POST` | `/observability/recordings/v0` | Session report (multipart: header + `chat_history` JSON + optional OGG audio). Accepts Basic **or** Bearer JWT. |
| `POST` | `/observability/logs/otlp/v0` | OTLP logs — tags, judge evaluations, outcomes, session-report patches. JSON or protobuf, gzip optional. |
| `POST` | `/observability/traces/otlp/v0` | OTLP traces — accepted, not persisted yet (200 no-op). |
| `POST` | `/observability/metrics/otlp/v0` | OTLP metrics — accepted, not persisted yet (per-turn metrics ride on the recording's `chat_history`). |

## Multi-tenancy: tagging calls by account

AO stores an `account_id` per session and lets you filter Monitor by it. It's
read from the session report's `room_tags.account_id` (set by your agent /
agent-transport room tags). Use it to separate calls by customer, environment,
or team. (Today this is a filter, not hard tenant isolation — see the roadmap in
the integration plan.)

## Verify telemetry is arriving

After a call completes:

```bash
# List recent sessions (add auth if you enabled it)
curl https://your-ao-host:9090/api/sessions \
  -u "$AO_USER:$AO_PASS"        # omit -u if auth is off

# -> {"objects":[ ... ],"meta":{"total_count":N, ...}}
```

Or just open **Monitor** in the dashboard and look for the call. Click it for
the transcript and the Performance tab (latency breakdown).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Unauthorized` on ingest | Agent credentials don't match AO's. For JWT, the key/secret pair differs between agent and server. |
| Calls never appear | `AGENT_OBSERVABILITY_URL` not set on the agent, AO not reachable from the agent's network, or the call didn't end cleanly (upload happens at call end). |
| Session shows but no audio | Audio upload is optional; for durable storage configure `S3_BUCKET` + credentials on AO (see guide 06). |
| No per-turn latency | The agent didn't emit per-turn metrics in `chat_history` — check your agent-transport version/config. |
| Can't tell calls apart by customer | Set `room_tags.account_id` on the agent so AO can group/filter by it. |

---

Next: **03 — Run evals in CI** *(planned)* to gate releases on agent quality, or
**04 — Run a simulation or live call** *(planned)* to QA an agent before launch.
