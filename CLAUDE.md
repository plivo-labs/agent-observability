# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

Agent Observability is a Bun/Hono server that receives session report callbacks from agent-transport (Python and Node SDKs). It parses the multipart session report (JSON header, chat history JSON, audio OGG), stores session data in Postgres, and serves a dashboard UI for viewing session metrics. All routes except `/health` can be gated with optional HTTP basic auth (`AGENT_OBSERVABILITY_USER` / `AGENT_OBSERVABILITY_PASS`).

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

1. Agent-transport SDK sends multipart POST to `/observability/recordings/v0` — basic auth header is required only when `AGENT_OBSERVABILITY_USER`/`_PASS` are configured on the server
2. Parses: JSON header (`session_id`, `start_time`, `room_tags.account_id`), chat history (JSON with per-turn metrics + usage), audio (OGG)
3. Extracts turn count and STT/LLM/TTS flags from chat history items
4. Optionally uploads audio to S3 (when `S3_BUCKET` and credentials are set)
5. Saves to `agent_transport_sessions` table

## Dashboard API

- `GET /api/sessions?limit=20&offset=0` — List sessions (paginated; `limit` clamps to [1, 20], optional `account_id` filter). Returns `{ objects, meta: { total_count, limit, offset, next, previous } }`.
- `GET /api/sessions/:id` — Session detail: includes `chat_history`, `session_metrics` (computed on the fly from raw data), `raw_report`, `events`, `options`.

## Migrations

SQL files in `migrations/` folder, named `001_description.sql`, `002_description.sql`, etc. Applied automatically on startup when `AUTO_MIGRATE=true`. Tracked in `_migrations` table.

## Environment Variables

See `.env.example` for all variables. Only `DATABASE_URL` is required. Basic auth (`AGENT_OBSERVABILITY_USER`/`_PASS`) and S3 upload (`S3_BUCKET` + credentials) are both opt-in — both env vars in each group must be set to enable the feature.

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
