# Full-text transcript search + Conversation Goals — design

Date: 2026-06-11
Status: approved (brainstorming session with Amal)
Origin: PLANS.md Plan 4 step 1 (transcript search) + new Goals feature
requested during design.

Two independent features designed together; they ship as separate PRs.
They share one substrate decision: both consume the session transcript,
each through a purpose-shaped derivation (flat text for the search
index, role-labeled text for the LLM analyzer).

Data shapes below were verified against real stored rows (42 sessions
in local Postgres, 2026-06-11): `chat_history` is a top-level JSONB
array of items typed `message` (role + `content: string[]`),
`function_call` (name, stringified-JSON arguments),
`function_call_output` (output, is_error), `agent_handoff`,
`agent_config_update`. All local sessions carry `chat_history`;
OTLP-native sessions instead accumulate chat items under
`raw_report->'events'`.

---

## Part 1 — Full-text transcript search

### Decisions (made interactively)

| Question | Decision |
|---|---|
| Search scope | Spoken transcript only: `content` of `type='message'` items in `chat_history`. Tool calls, error strings, and `raw_report->'events'` are out of scope for v1. |
| UX | Search box in the existing sessions-table toolbar. Typing narrows the table; composes with transport/date/agent filters. No snippets, no dedicated page, no ranking — results stay sorted `ended_at DESC`. |
| Matching | Word search: `tsvector` GIN index queried with `websearch_to_tsquery('english', q)`. No `pg_trgm`, no extensions at all. |
| Storage | `STORED` generated column derived from `chat_history`; DB-owned, zero ingest-code changes. |

### Migration: `migrations/018_transcript_search.sql`

1. `extract_transcript(jsonb) RETURNS text` — `IMMUTABLE` SQL function.
   Walks the top-level array, keeps `item->>'type' = 'message'`,
   concatenates the elements of each item's `content` string array,
   newline-separated, in array order. Returns `NULL` for `NULL` input
   or when no message content exists. Content only — **no role
   prefixes**, so `user`/`assistant` never become searchable tokens.
2. `ALTER TABLE agent_transport_sessions ADD COLUMN transcript_text
   text GENERATED ALWAYS AS (extract_transcript(chat_history)) STORED;`
   The ALTER rewrites the table and backfills every existing row;
   Postgres maintains the column on all future writes.
3. Expression index:
   `CREATE INDEX idx_ats_transcript_fts ON agent_transport_sessions
   USING gin (to_tsvector('english', transcript_text));`

### API: `GET /api/sessions` gains optional `q`

- Predicate, added to the existing predicate-builder alongside
  `account_id` / `agent_id` / `transport`:
  `to_tsvector('english', transcript_text) @@
  websearch_to_tsquery('english', $q)`
  (expression must match the index expression exactly).
- `q` is bound as a parameter, raw. `websearch_to_tsquery` never
  throws on malformed input, so no escaping layer. Web-search syntax
  (`"exact phrase"`, `-exclude`, `or`) works as a side effect.
- Blank/whitespace-only `q` is ignored (no predicate). A stopword-only
  query (e.g. `the`) produces an empty tsquery and matches zero rows —
  accepted behavior.
- Applied to both the rows query and the count query so
  `meta.total_count` / pagination stay correct.
- Rows with `transcript_text IS NULL` never match an active query.

### Frontend

- `sessions-page.tsx`: debounced search input in the DataTable
  toolbar, URL-synced via nuqs key `q`. Works in standalone and
  agent-embedded (`agentId` prop) modes.
- `useSessions` (observability-hooks) and the API client thread the
  new `q` option. **Registry-shared file**: edit
  `packages/ui/registry/new-york/observability-hooks/` first, run
  `cd packages/ui && bun run build`, commit regenerated `public/r/`,
  then place the verbatim copy at `frontend/src/lib/` (CLAUDE.md
  sharing contract; docs deploy may need a webpack alias — see
  docs-registry-alias-trap).

### Testing

- `tests/` (mocked db): `q` threading into SQL params; blank `q`
  ignored.
- `tests-integration/` (real Postgres): migration applies; insert
  sessions with known transcripts; assert hit/miss; stemming
  ("cancel" finds "cancelled"); quoted phrase; `-exclusion`; null
  `chat_history` row never matches; `total_count` correct under `q`
  with pagination.

### Known limitations (v1, recorded deliberately)

- **OTLP-native sessions** whose transcript lives only under
  `raw_report->'events'` are not searchable. `extract_transcript` is
  the single extension point if/when needed.
- **No speaker scoping**: user and assistant content are indexed
  together, so "cancel my subscription" matches whichever side said
  it. Upgrade path without schema churn: rebuild the index with
  `setweight(to_tsvector(user_text),'A') ||
  setweight(to_tsvector(assistant_text),'B')` and weight-qualified
  tsqueries (`'cancel':A`).
- No semantic search. `tsvector` is lexical (stemmed words), not
  embeddings. If ever needed, `transcript_text` is the column you'd
  embed (pgvector) — explicitly out of scope.

---

## Part 2 — Conversation Goals

User-defined plain-text goals per agent; after a session ends, an LLM
reads the conversation and judges whether each goal was met.

### Decisions (made interactively)

| Question | Decision |
|---|---|
| Where goals are defined | Agent code, mirroring evaluation-config: no dashboard CRUD. Goals travel in the session payload. |
| Runner | Background worker sweep (same loop as the alert sweeper), one OpenAI chat call per session. |
| LLM config | Same contract as the Python judge helper: model `JUDGE_LLM_MODEL` → `OPENAI_MODEL` → `gpt-4.1-mini`; feature enabled only when `OPENAI_API_KEY` is set (off + one startup log otherwise). OpenAI SDK first; other providers later. |
| Results storage | Existing `session_external_evals` table, `source='goal'`. No new results table. |
| Results UI | New **Conversation Goals** tab, last tab on the agent detail page. |

### Goal transport (SDK → server)

- Both SDKs (`plugins/agent-observability-sdk`,
  `plugins/agent-observability-sdk-node`) add a `goals: list[str]`
  parameter to the existing `apply_observability_tags` helper.
- Each goal is emitted as a tag string `goal:<text>` — the same
  channel `account_id:<value>` already uses, so goals ride both
  ingest paths unchanged:
  - recording path: header `room_tags` → `raw_report.tags`
  - OTLP path: `"tag"` records → `session_tags`
- Server-side `extractGoals(session)` mirrors the existing
  `extractAccountId` precedent (`src/index.ts:213`): collect every
  tag with the `goal:` prefix from `raw_report` tags and
  `session_tags`, preserving order, deduplicated.
- Goal text constraint: tags are plain strings; commas and colons
  after the prefix are part of the goal text. Practical length cap
  enforced at analysis time (goal text truncated at 500 chars).

### Analyzer job (worker sweep)

New module `src/goals/` wired into the existing background loop:

- Runs inside `src/worker.ts`'s loop next to `runSweepOnce()`, and —
  mirroring `ALERT_SWEEPER=inline` — inline on the API process by
  default via a `GOAL_ANALYZER=inline|off` env (default `inline`),
  so single-container deploys need zero config and worker deploys set
  it `off` on the API.
- Tracking table (same migration as the feature,
  `migrations/019_session_goal_analyses.sql`):
  `session_goal_analyses(session_id text PK, status
  text CHECK (status IN ('claimed','done','error')), attempts int NOT
  NULL DEFAULT 0, last_error text, claimed_at timestamptz, analyzed_at
  timestamptz, created_at timestamptz NOT NULL DEFAULT now())`.
- Sweep query: sessions that (a) yield ≥1 goal via `extractGoals`,
  (b) have non-null `chat_history` with ≥1 message item, (c) have no
  `session_goal_analyses` row that is `status='done'`, or
  `attempts >= 3`, or `status='claimed'` with a fresh `claimed_at`
  (claims older than 10 minutes are considered stale and reclaimable —
  a crashed analyzer can't strand a session). Batch limit 10 sessions
  per sweep so a slow sweep can't pile up.
- Claim protocol (API-inline and worker may run concurrently): before
  analyzing, atomically claim via
  `INSERT … (session_id, status, claimed_at) VALUES ($id, 'claimed',
  now()) ON CONFLICT (session_id) DO UPDATE SET status='claimed',
  claimed_at=now() WHERE session_goal_analyses.status='error' OR
  (status='claimed' AND claimed_at < now() - interval '10 minutes')
  RETURNING session_id` — proceed only when a row comes back. This is
  the same at-most-once discipline the alert sweeper uses for
  suppression stamps; duplicate verdict rows cannot occur.
- Per session:
  1. Render a role-labeled transcript in TypeScript from
     `chat_history` (`caller:` / `agent:` lines). The search column is
     deliberately content-only; the LLM needs speakers. Truncate to a
     48k-character budget keeping the tail (sessions end with
     resolution; the end matters most for goal judgment) and noting
     truncation in the prompt.
  2. One OpenAI chat call covering **all** goals, JSON-structured
     output: per goal `{ met: boolean, reasoning: string,
     what_went_wrong: string | null }`.
  3. Insert one `session_external_evals` row per goal:
     `source='goal'`, `judge_name='goal'`, `instructions=<goal text>`,
     `verdict='met'|'unmet'`, `reasoning=<model reasoning>`,
     `raw=<full per-goal model output>`, `observed_at=now()`.
  4. Upsert tracking row `status='done'`; on failure increment
     `attempts`, store `last_error`, retry on a later sweep until the
     attempt cap.

The judge prompt (strictness, partially-met handling) is a product
decision reserved for Amal to author during implementation.

### UI — Conversation Goals tab

- Agent detail page tab order becomes: Sessions, Simulation Evals,
  Conversation Evals, **Conversation Goals** (last).
- Tab contents:
  - Header stat: goal completion rate (met / total verdicts) across
    analyzed sessions of this agent.
  - Paginated table: session id (links to session detail), started
    time, per-goal met/unmet badges, expandable reasoning +
    what-went-wrong text.
- Backed by a new endpoint
  `GET /api/agents/:id/goal-results?limit&offset`, reading
  `session_external_evals` (`source='goal'`) joined to
  `agent_transport_sessions` filtered by agent.
- Free side effect of the storage choice: goal verdicts also appear in
  the existing per-session evaluations drawer with zero new code.

### Error handling

- No `OPENAI_API_KEY` → analyzer disabled; one log line at startup.
- LLM call failure / malformed JSON → `status='error'`, `attempts+1`,
  retried on later sweeps up to 3 attempts, then left visible in the
  tracking table (`last_error`).
- Sessions without goals or without transcripts are never enqueued.
- Goal verdict writes for one session are transactional with the
  tracking-row update (no half-written verdict sets marked done).

### Testing

- `tests/` (mocked db): `extractGoals` precedence/dedup; analyzer unit
  tests with an injected fake OpenAI client (success, malformed JSON,
  API error → retry bookkeeping); transcript rendering + truncation.
- `tests-integration/` (real Postgres, stubbed LLM): end-to-end sweep —
  insert session with goal tags, run one sweep, assert
  `session_external_evals` rows + `session_goal_analyses` row; retry
  path; attempt cap; concurrent-sweep claim safety.
- SDK tests (both languages): `goals=[...]` emits `goal:<text>` tags.

### Sequencing / PRs

1. PR 1 — transcript search (migration 018, API `q`, toolbar UI,
   registry-shared hook update). No SDK changes.
2. PR 2 — goals server side (migration 019, `extractGoals`, analyzer
   module, worker + inline wiring, `/api/agents/:id/goal-results`,
   Conversation Goals tab).
3. PR 3 — SDK `goals` parameter (Python + Node; separate notes-filter
   labels `agent-observability-sdk` / `agent-observability-sdk-node`;
   can be one PR per SDK if cleaner for release notes).

PR 2 is testable before PR 3 ships by emitting `goal:` tags manually.
