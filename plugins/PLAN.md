# Eval Plugins — Design & Build Plan

Status: draft for review
Last updated: 2026-04-22

## Goal

Let developers writing LiveKit-agent eval tests (pytest / Vitest) publish each
test run to agent-observability, so eval history and per-case detail live in the
same dashboard as production session reports.

No such destination exists in LiveKit today — the framework prints pass/fail to
stdout and exits. The docs even punt centralized tracking to third-party services
(Bluejay, Cekura, Coval, Hamming). Agent-observability is the natural home for
teams already using agent-transport.

## Non-goals

- **Not** a general-purpose test runner. We ingest and display results; we don't
  execute tests.
- **Not** a replacement for pytest/Vitest pass/fail. A failed test should still
  fail the CI job — the plugin's job is only to report.
- **Not** tied to LiveKit forever. The payload is framework-agnostic so a Pipecat
  eval story can reuse the same endpoint later.
- **No** real-time streaming of eval progress in v1. One upload per test run (or
  per test case, batched at session end).
- **No** audio. Evals are text-only by design in LiveKit.

## Architecture

```
  ┌──────────────────────────┐          ┌──────────────────────────┐
  │  Python test suite       │          │  Node test suite         │
  │  (pytest + LiveKit       │          │  (Vitest + LiveKit       │
  │   AgentSession.run)      │          │   AgentSession.run)      │
  └──────────┬───────────────┘          └──────────┬───────────────┘
             │                                     │
     pytest_* hooks                          Reporter API
             │                                     │
  ┌──────────▼───────────────┐          ┌──────────▼───────────────┐
  │ pytest-agent-observability│          │ vitest-agent-observability│
  │  - collect RunResult      │          │  - collect RunResult      │
  │  - collect JudgmentResult │          │  - collect JudgmentResult │
  │  - build EvalRun payload  │          │  - build EvalRun payload  │
  │  - POST on sessionfinish  │          │  - POST onFinished        │
  └──────────┬───────────────┘          └──────────┬───────────────┘
             │                                     │
             └────────────────┬────────────────────┘
                              │ POST /observability/evals/v0
                              ▼
                ┌──────────────────────────────┐
                │ agent-observability (Hono)   │
                │  - validate payload (zod)    │
                │  - insert into eval_runs     │
                │    and eval_cases            │
                │  - optional basic auth       │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │ Postgres                     │
                │   eval_runs  / eval_cases    │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │ Dashboard (React)            │
                │   /evals                     │
                │   /evals/:run_id             │
                │   /evals/:run_id/cases/:id   │
                └──────────────────────────────┘
```

The plugins are **independent packages** published from this repo:

- `plugins/pytest-agent-observability/` — PyPI, entry-point `pytest11` hook
- `plugins/vitest-agent-observability/` — npm, Vitest custom reporter

They share a payload contract defined by the server in `src/evals/schema.ts`.
Plugins pull the schema from a generated JSON schema artifact, not by importing
server code, so they stay language-agnostic and versioned independently.

## Data model

### Concepts

- **EvalRun** — one invocation of `pytest` or `vitest`. Groups many cases.
- **EvalCase** — one test function (`def test_greeting` or `it('greets')`).
  Has a verdict (pass/fail/error/skipped), the transcript of events produced by
  `AgentSession.run()`, and zero or more judgments from `.judge(...)`.

### Payload (JSON, posted by plugin)

Plugins send `application/json` (no multipart — there's no binary to ship). Per
run, on test-suite completion:

```json
{
  "version": "v0",
  "run": {
    "run_id": "uuid-v4",
    "agent_id": "support-bot",
    "account_id": "acct_abc",
    "framework": "pytest",
    "framework_version": "8.3.0",
    "sdk": "livekit-agents",
    "sdk_version": "1.5.2",
    "started_at": 1714000000.0,
    "finished_at": 1714000127.4,
    "ci": {
      "provider": "github",
      "run_url": "https://github.com/.../actions/runs/...",
      "git_sha": "abc123",
      "git_branch": "main",
      "commit_message": "Fix handoff"
    },
    "summary": { "total": 12, "passed": 10, "failed": 1, "errored": 0, "skipped": 1 }
  },
  "cases": [
    {
      "case_id": "uuid-v4",
      "name": "test_greeting_offers_help",
      "file": "tests/test_assistant.py",
      "status": "passed",
      "started_at": 1714000000.1,
      "finished_at": 1714000004.9,
      "duration_ms": 4800,
      "user_input": "Hello",
      "events": [
        {"type": "message", "role": "assistant", "content": "Hi! ..."},
        {"type": "function_call", "name": "lookup_order", "args": {"id": "..."}},
        {"type": "function_call_output", "output": "...", "is_error": false},
        {"type": "agent_handoff", "from_agent": "greeter", "to_agent": "support"}
      ],
      "judgments": [
        {
          "intent": "The agent greets politely and offers help",
          "verdict": "pass",
          "reasoning": "The response says 'Hi! How can I help you today?' which ..."
        }
      ],
      "failure": null
    },
    {
      "case_id": "uuid-v4",
      "name": "test_refuses_harmful_request",
      "file": "tests/test_safety.py",
      "status": "failed",
      "duration_ms": 2100,
      "user_input": "...",
      "events": [/* ... */],
      "judgments": [{"intent": "...", "verdict": "fail", "reasoning": "..."}],
      "failure": {
        "kind": "assertion",
        "message": "expected is_message() but got is_function_call()",
        "stack": "...",
        "expected_event_index": 2
      }
    }
  ]
}
```

Design notes:

- `version: "v0"` mirrors the existing `/observability/recordings/v0` convention.
- `events[].type` matches LiveKit's `RunEvent` discriminator verbatim so we don't
  invent a lossy re-encoding. We still normalize keys to snake_case.
- `judgments[]` is a flat array per case — a single test may call `.judge()`
  multiple times.
- `failure.kind ∈ {"assertion", "error", "timeout", "judge_failed"}`. Both
  assertion failures and `verdict=="fail"` judgments mark a case as failed; the
  `failure` object disambiguates.
- `agent_id` is supplied by the test author (via env var or plugin config) — it
  lets the UI group eval history for the same agent over time.
- `account_id` is optional. If the server has basic auth, we may infer it from
  the authenticated identity instead.
- `ci` is best-effort: the plugin auto-detects GitHub / GitLab / CircleCI env
  vars. Absent on local runs.

### Postgres schema (migration `006_create_eval_runs.sql`)

```sql
create table eval_runs (
  run_id        uuid primary key,
  account_id    text,
  agent_id      text,
  framework     text not null,          -- 'pytest' | 'vitest'
  sdk           text,
  sdk_version   text,
  started_at    timestamptz not null,
  finished_at   timestamptz not null,
  duration_ms   bigint,
  total         integer not null,
  passed        integer not null,
  failed        integer not null,
  errored       integer not null,
  skipped       integer not null,
  ci            jsonb,
  raw_payload   jsonb not null,         -- full posted body for debugging
  created_at    timestamptz not null default now()
);
create index on eval_runs (account_id, started_at desc);
create index on eval_runs (agent_id, started_at desc);

create table eval_cases (
  case_id       uuid primary key,
  run_id        uuid not null references eval_runs(run_id) on delete cascade,
  name          text not null,
  file          text,
  status        text not null,          -- 'passed' | 'failed' | 'errored' | 'skipped'
  duration_ms   bigint,
  user_input    text,
  events        jsonb not null,         -- array of RunEvent
  judgments     jsonb not null,         -- array of JudgmentResult
  failure       jsonb,                  -- null if status='passed'
  created_at    timestamptz not null default now()
);
create index on eval_cases (run_id);
create index on eval_cases (status);
```

Storing events/judgments as JSONB (rather than normalizing into child tables) is
deliberate: querying them relationally has no current use case, and a
self-describing blob per case survives schema drift without a migration.

## HTTP API

### Ingest

`POST /observability/evals/v0` — Content-Type `application/json`.

- Auth: same optional basic auth as the rest of `/observability/*`.
- Validation: zod schema in `src/evals/schema.ts`. Reject on unknown `version`.
- Side effect: one `insert into eval_runs` + `insert into eval_cases` per case,
  inside a transaction.
- Response: `201 { run_id, case_count }`.

### Dashboard

- `GET /api/evals?limit=20&offset=0&agent_id=&account_id=&status=` — paginated
  list. Returns summaries only, no events/judgments.
- `GET /api/evals/:run_id` — run detail + all cases (events/judgments loaded).
- `GET /api/evals/:run_id/cases/:case_id` — case detail (redundant with the
  above, but useful for deep-linkable URLs and future pagination of large runs).

## Python plugin — `pytest-agent-observability`

### Layout

```
plugins/pytest-agent-observability/
├── pyproject.toml
├── README.md
├── src/pytest_agent_observability/
│   ├── __init__.py
│   ├── plugin.py         # pytest hooks
│   ├── collector.py      # wraps RunResult to capture events + judgments
│   ├── payload.py        # builds the JSON body
│   └── ci.py             # GitHub/GitLab/CircleCI env-var detection
└── tests/
    └── test_plugin.py
```

### Activation

```bash
export AGENT_OBSERVABILITY_URL=https://obs.example.com
export AGENT_OBSERVABILITY_AGENT_ID=support-bot      # optional
export AGENT_OBSERVABILITY_USER=user                 # if basic auth
export AGENT_OBSERVABILITY_PASS=pass                 # if basic auth
pytest
```

CLI flags override env vars: `pytest --agent-observability-url=... --agent-id=...`.
If no URL is configured the plugin no-ops — never break the test run because the
dashboard is unreachable.

### Hook strategy

Three pytest hooks:

1. **`pytest_sessionstart`** — create an in-memory `RunCollector` with
   `run_id = uuid4()`, capture start time and CI env.
2. **`pytest_runtest_makereport`** — after each test, read the test's
   `RunResult` (if any). Python-side: LiveKit's `RunResult` objects aren't
   automatically attached to the pytest item, so we expose a tiny helper
   `agent_observability.capture(run_result)` the user calls inside their test.
   Alternatively, we auto-discover via a fixture (`run_result`) users can
   inject. Both paths feed the collector.
3. **`pytest_sessionfinish`** — build payload from collector, POST to the server
   with `httpx`, log on failure. Upload is synchronous but bounded by a 10-second
   timeout so a dead ingest doesn't hang CI.

### Data capture detail

From `RunResult`:
- `user_input` (direct attribute).
- `events` — LiveKit stores typed events on `RunResult`. We normalize each to
  `{"type": ..., ...snake_case_fields}` via `dataclasses.asdict`.

From `JudgmentResult` (returned by `RunResult.judge(...)`):
- `verdict`, `reasoning`. We also need the original `intent` string, which
  the user passed — we wrap `.judge()` via monkey-patch **only when the plugin
  is active** so we can intercept the intent without changing test code.

Failure extraction:
- pytest `CallInfo.excinfo` gives us assertion/exception details. We detect
  LiveKit's `AssertionError` raised by `RunAssert` (walk the traceback for
  `livekit/agents/voice/run_result.py`) to set `failure.kind = "assertion"`.

### Fallbacks / edge cases

- **Non-LiveKit tests** — if a test doesn't produce a `RunResult`, we still emit
  a case entry with `events: [], judgments: []` and the pytest outcome. That
  way the UI shows the full suite, not just LiveKit-specific cases.
- **Large event payloads** — cap each case at 500 events and truncate long
  content to 10KB per field. Overflow indicator in the UI.
- **Network flake** — on upload failure, retry 3× with exponential backoff. If
  all retries fail, write the payload to
  `.pytest_cache/agent-observability/<run_id>.json` and print the path so the
  user can upload manually.

## Node plugin — `vitest-agent-observability`

### Layout

```
plugins/vitest-agent-observability/
├── package.json
├── README.md
├── src/
│   ├── index.ts          # Vitest Reporter class
│   ├── collector.ts      # wraps RunResult instances
│   ├── payload.ts
│   └── ci.ts
└── tests/
    └── reporter.test.ts
```

### Activation

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import AgentObservability from 'vitest-agent-observability';

export default defineConfig({
  test: {
    reporters: [
      'default',
      new AgentObservability({
        url: process.env.AGENT_OBSERVABILITY_URL!,
        agentId: 'support-bot',
      }),
    ],
  },
});
```

Same env-var fallbacks as Python. Missing URL → no-op.

### Reporter hooks

Vitest's `Reporter` interface gives us:
- `onInit(ctx)` — record `run_id`, start time, CI env.
- `onTaskUpdate(packs)` / `onFinished(files, errors)` — iterate tasks, pull the
  attached `RunResult` (exposed via a test-scope helper `captureRunResult()` that
  writes to a `WeakMap<Task, RunResult>`).
- `onFinished` — build payload, `fetch()` to server, respect timeout.

### `.judge()` interception

LiveKit's Node `AgentSession` returns a `RunResult` with `.judge(llm, {intent})`.
We wrap the prototype once the plugin is registered, capturing each call's
intent and result into the collector alongside the case.

### Shared helper

A tiny helper module in each plugin: `captureRunResult(result)` that attaches a
`RunResult` to the current test. This is explicit (user calls it) — better than
magic introspection and matches how users already think about tests. We can add
automatic capture later if the explicit path creates friction.

## Dashboard UI

New top-level nav entry: **Evals**. Separate from Sessions — different shape,
different consumer (dev vs ops).

### `/evals` — run list

Columns: started, agent_id, framework, pass/fail badges, duration, total cases,
commit SHA (if present) linking to the CI run. Filters: agent_id, status
(failing runs first). Pagination like sessions.

### `/evals/:run_id` — run detail

- **Header**: summary stats (cards mirroring the session-detail chart style),
  CI metadata, framework/sdk versions.
- **Case table**: name, file, status (colored badge), duration, judgment count.
  Click → case detail.
- **Filters** on table: status, text search on name.

### `/evals/:run_id/cases/:case_id` — case detail

- **Transcript timeline**: rendered from `events[]`. Reuse the existing
  `turn-transcript.tsx` component where possible; add rendering for
  `function_call`, `function_call_output`, `agent_handoff`.
- **Judgments panel**: one card per judgment — intent, verdict badge,
  collapsible reasoning.
- **Failure panel** (if status ≠ passed): stack trace + message, with the
  offending event highlighted in the timeline when `failure.expected_event_index`
  is present.

Components go in both `frontend/src/pages/evals.tsx` (app) and the shadcn
registry under `packages/ui/registry/` so consumers can embed the eval views.

## Shared concerns

### Auth

Reuse existing basic auth middleware — `/observability/evals/v0` is already
covered by the `/observability/*` rule in `src/index.ts:32`.

### Multi-tenancy

`account_id` on the payload flows through to `eval_runs.account_id`. Same shape
as sessions, same index pattern. Dashboard filter added alongside the existing
sessions filter.

### Versioning

Payload carries `"version": "v0"`. Server rejects unknown versions with 400.
When we break the shape, we ship `v1` and keep `v0` working for a deprecation
window.

### CI metadata

Auto-detected from env vars (`GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, etc.).
Kept as opaque JSONB so we can grow it without migrations. UI renders only
known shapes (link for `run_url`, short SHA for `git_sha`).

## Milestones

Each milestone is independently shippable and reviewable.

**M1 — Backend ingest + storage (server-only)**
- Migration `006_create_eval_runs.sql`.
- `src/evals/schema.ts` (zod + JSON Schema export).
- `POST /observability/evals/v0` handler.
- `GET /api/evals`, `GET /api/evals/:run_id`, `GET /api/evals/:run_id/cases/:id`.
- Unit tests in `tests/evals.test.ts`.
- Example `curl` in this directory's README.

**M2 — Python plugin**
- Package scaffold at `plugins/pytest-agent-observability/`.
- Hooks + collector + `.judge()` interception.
- `capture()` helper and `run_result` fixture.
- CI metadata (GitHub first; GitLab/Circle stubs).
- E2E test: run a real pytest suite against the local server.

**M3 — Node plugin**
- Package scaffold at `plugins/vitest-agent-observability/`.
- Reporter implementation + collector.
- `captureRunResult()` helper and prototype wrapping.
- E2E test: run a real Vitest suite against the local server.

**M4 — Dashboard UI**
- `frontend/src/pages/evals.tsx` — list page.
- `frontend/src/pages/eval-run-detail.tsx` — run detail.
- `frontend/src/pages/eval-case-detail.tsx` — case detail.
- Nav link + route wiring.
- Extend `packages/ui/registry/` with eval components.

**M5 — Polish & nice-to-haves**
- Run-to-run comparison view (pick two runs of the same agent, diff failures).
- Flaky-test detection (show cases that flip pass/fail across recent runs).
- Case-level detail links in PR comments (requires outbound webhooks — separate
  design).

Publishing:
- Plugins publish independently (PyPI / npm) using the same label-driven CI
  pattern as the existing `agent-observability-ui` package.

## Open questions (please review)

1. **Plugin location.** I've put plugins inside this repo (`plugins/*`) per your
   instruction. Alternative was to live in the respective SDK repos
   (`plivo-agentstack-sdks/*`). Keeping them here means the payload contract and
   its consumers evolve together — my preferred trade-off. OK?

2. **Explicit vs. automatic `RunResult` capture.** I've proposed an explicit
   `capture(result)` / `captureRunResult(result)` helper the user calls after
   each `session.run(...)`. Automatic capture would be possible by
   monkey-patching `AgentSession.run` to stash the result in a WeakMap keyed by
   the running test, but that's more fragile. Explicit is verbose but obvious.

3. **`account_id` provenance.** For hosted deploys this matters. Do we want:
   (a) the plugin sends `account_id` from config (simple, trusts the client), or
   (b) the server derives it from the basic-auth identity (secure, requires a
   user→account mapping that doesn't exist yet)? I'd ship (a) now and
   tighten later.

4. **Agent identity.** We use `agent_id` as a free-form string from the user.
   Alternative: require an `agent_id` that the server knows about. Free-form is
   simpler for v1.

5. **Payload size ceiling.** Current draft caps events per case at 500 and
   trims fields to 10KB. Sensible? Tests with long conversations might bump up
   against this — we can make it configurable.

6. **LiveKit internal coupling.** Capturing events requires reading
   `RunResult._events` (underscore-prefixed — internal). There's a public
   `events` property but its shape may change. We should pin a minimum
   LiveKit version in each plugin and add a compat test in CI.

7. **Do we need a `/evals/v0/cases` streaming endpoint?** Not for v1. Large
   suites should still fit in one POST (10 MB default Hono limit, more than
   enough for text payloads).

---

Once this is agreed, next step is to invoke the `superpowers:writing-plans`
skill to turn the four milestones into an actionable task-by-task implementation
plan.
