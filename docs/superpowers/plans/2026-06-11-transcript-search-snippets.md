# Transcript Search Snippets + In-Transcript Annotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a transcript search (`?q=`) is active, show a match excerpt under each row in the sessions list, and highlight + scroll to matches in the transcript when a session is opened from that search.

**Architecture:** The server adds a `ts_headline()` column (`match_snippet`) to `GET /api/sessions` rows only when `q` is present — same tsquery as the filter, control-char match markers, computed only for the returned page. The frontend renders the snippet as a sub-row in the sessions table, carries `?q=` through navigation, and annotates the transcript client-side with a word-prefix stemming approximation.

**Tech Stack:** Bun + Hono + bun:sql (Postgres `ts_headline`), React 19 + TanStack Table + Tailwind v4. Five registry-shared files (`packages/ui/registry/new-york/**` is the source of truth; `frontend/src/**` carries verbatim copies — see CLAUDE.md sharing contract).

**Spec:** `docs/superpowers/specs/2026-06-11-transcript-search-snippets-design.md`

**Known baseline failure (pre-existing on main, do NOT fix or chase):**
`tests/routes.test.ts` › "rejects an oversized body with 413 before reading it" fails (401 instead of 413) on the branch-off commit `4a92317`. Expected test results everywhere below mean "everything passes except this one known failure".

**Conventions:**
- Run unit tests with `bun test ./tests/` (NOT bare `bun test` — that also picks up `tests-integration/`).
- Integration tests need Postgres: `docker compose up postgres -d`, then `bun run test:integration`.
- Commits: no `Co-Authored-By` trailers.
- Registry-shared edits: edit `packages/ui/registry/new-york/<item>/…` FIRST, then `cp` to the `frontend/src/…` path. Never let the two drift within a commit.

---

### Task 1: API — `match_snippet` via `ts_headline` on `GET /api/sessions`

**Files:**
- Modify: `src/index.ts` (the `/api/sessions` GET handler, ~lines 377–467)
- Test: `tests/dashboard-api.test.ts` (insert after the "carries q through pagination links" test, ~line 205)

- [ ] **Step 1: Write the failing tests**

Add to `tests/dashboard-api.test.ts` directly after the `"carries q through pagination links"` test:

```ts
  test("selects a ts_headline match_snippet on rows when q is active", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?q=refund", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    // The count query never pays for headline generation.
    const [countQuery] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(countQuery).not.toContain("ts_headline");

    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    // $1 is the q param (the q predicate is always pushed first); the
    // options string rides as the last param, after LIMIT/OFFSET.
    expect(rowsQuery).toContain(
      "ts_headline('english', transcript_text, websearch_to_tsquery('english', $1), $4) AS match_snippet"
    );
    expect(rowsParams).toEqual([
      "refund",
      20,
      0,
      'StartSel=\u0001, StopSel=\u0002, MaxFragments=2, MaxWords=12, MinWords=6, FragmentDelimiter=" … "',
    ]);
  });

  test("keeps snippet param numbering correct alongside other filters", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions?q=refund&agent_id=agent-1", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    // params: $1=q, $2=agent_id, $3=limit, $4=offset, $5=headline options
    expect(rowsQuery).toContain(
      "ts_headline('english', transcript_text, websearch_to_tsquery('english', $1), $5) AS match_snippet"
    );
    expect(rowsQuery).toContain("LIMIT $3 OFFSET $4");
    expect(rowsParams).toHaveLength(5);
  });

  test("omits match_snippet entirely without q", async () => {
    mockSql
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await server.fetch(
      makeRequest("/api/sessions", {
        headers: { Authorization: basicAuthHeader() },
      })
    );
    expect(res.status).toBe(200);

    const [rowsQuery, rowsParams] = mockSql.mock.calls[1] as [string, unknown[]];
    expect(rowsQuery).not.toContain("ts_headline");
    expect(rowsParams).toEqual([20, 0]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./tests/dashboard-api.test.ts -t "match_snippet"`
Expected: the two snippet-presence tests FAIL (query does not contain `ts_headline`); the omission test PASSES (it asserts current behavior — that's fine, it guards the regression).

- [ ] **Step 3: Implement**

In `src/index.ts`, add a module-level constant directly above the `app.get("/api/sessions", …)` handler:

```ts
/** ts_headline() options for /api/sessions match snippets. StartSel/StopSel
 * are control characters — they cannot occur in spoken transcript text, and
 * the dashboard splits on them to render <mark> spans (never raw HTML).
 * Two ~12-word fragments, joined with " … ".
 * Mirrored verbatim in tests-integration/transcript-search.test.ts. */
const TS_HEADLINE_OPTIONS =
  'StartSel=\u0001, StopSel=\u0002, MaxFragments=2, MaxWords=12, MinWords=6, FragmentDelimiter=" … "';
```

Then replace the rows query block (currently):

```ts
  const rows = await sql.unsafe(
    `SELECT id, session_id, account_id, agent_id, agent_name, transport, state, started_at, ended_at, duration_ms,
            turn_count, has_stt, has_llm, has_tts, record_url, created_at
     FROM agent_transport_sessions
     ${whereClause}
     ORDER BY ended_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
```

with:

```ts
  // Match excerpt for an active transcript search: ts_headline() reuses the
  // exact tsquery the predicate used, so stemming, quoted phrases, and
  // -exclusions agree with the filter by construction. It runs only on the
  // returned page — the GIN-indexed predicate narrowed the set first. $1 is
  // always the q param because the q predicate is pushed first above.
  const rowsParams: unknown[] = [...params, limit, offset];
  let snippetCol = "";
  if (q) {
    snippetCol = `, ts_headline('english', transcript_text, websearch_to_tsquery('english', $1), $${rowsParams.length + 1}) AS match_snippet`;
    rowsParams.push(TS_HEADLINE_OPTIONS);
  }

  const rows = await sql.unsafe(
    `SELECT id, session_id, account_id, agent_id, agent_name, transport, state, started_at, ended_at, duration_ms,
            turn_count, has_stt, has_llm, has_tts, record_url, created_at${snippetCol}
     FROM agent_transport_sessions
     ${whereClause}
     ORDER BY ended_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    rowsParams,
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./tests/dashboard-api.test.ts`
Expected: ALL tests in this file PASS.

Run: `bun test ./tests/`
Expected: only the known baseline failure (`routes.test.ts` 413 test).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/dashboard-api.test.ts
git commit -m "Add ts_headline match_snippet to GET /api/sessions when q is active"
```

---

### Task 2: Integration tests — snippet content against real Postgres

**Files:**
- Test: `tests-integration/transcript-search.test.ts` (append a new `describeDb` block at the end)

- [ ] **Step 1: Start Postgres and confirm the existing suite is green**

```bash
docker compose up postgres -d
bun run test:integration
```
Expected: all integration tests PASS (they self-skip if the DB is unreachable — if you see skips, the DB isn't up; fix that before continuing).

- [ ] **Step 2: Append the snippet tests**

At the end of `tests-integration/transcript-search.test.ts` add:

```ts
/** Mirrors TS_HEADLINE_OPTIONS in src/index.ts — keep in sync. The unit
 *  suite (tests/dashboard-api.test.ts) pins the endpoint-side string, so a
 *  drift fails there, not silently here. */
const HEADLINE_OPTS =
  'StartSel=\u0001, StopSel=\u0002, MaxFragments=2, MaxWords=12, MinWords=6, FragmentDelimiter=" … "';

const th = testRun("ftsh");

/** The exact SELECT expression GET /api/sessions adds for ?q= snippets. */
async function snippetOf(acct: string, q: string): Promise<string | null> {
  const rows = await sql.unsafe(
    `SELECT ts_headline('english', transcript_text, websearch_to_tsquery('english', $2), $3) AS match_snippet
     FROM agent_transport_sessions
     WHERE account_id = $1
       AND to_tsvector('english', transcript_text) @@ websearch_to_tsquery('english', $2)`,
    [acct, q, HEADLINE_OPTS],
  );
  return rows[0]?.match_snippet ?? null;
}

describeDb("match_snippet headline", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  afterAll(async () => {
    await th.cleanup();
  });

  test("wraps stemmed matches in control-char markers", async () => {
    const acct = th.uid("acct");
    await th.seedSession({
      accountId: acct,
      chatHistory: [msg("user", "I want to cancel my subscription today.")],
    });
    // "cancellation" stems to "cancel" — the snippet must mark the stored word.
    const snippet = await snippetOf(acct, "cancellation");
    expect(snippet).toContain("\u0001cancel\u0002");
    expect(snippet).toContain("subscription");
  });

  test("marks each word of a quoted phrase match", async () => {
    const acct = th.uid("acct");
    await th.seedSession({
      accountId: acct,
      chatHistory: [msg("assistant", "Your refund request was processed yesterday.")],
    });
    const snippet = await snippetOf(acct, '"refund request"');
    expect(snippet).toContain("\u0001refund\u0002");
    expect(snippet).toContain("\u0001request\u0002");
  });

  test("joins two distant fragments with the delimiter", async () => {
    const acct = th.uid("acct");
    const filler = Array.from({ length: 30 }, (_, i) =>
      msg("assistant", `Filler sentence number ${i} about the weather and traffic conditions.`),
    );
    await th.seedSession({
      accountId: acct,
      chatHistory: [
        msg("user", "I need a refund for my last order."),
        ...filler,
        msg("user", "So when exactly will the refund arrive?"),
      ],
    });
    const snippet = await snippetOf(acct, "refund");
    expect(snippet).toContain(" … ");
    expect(snippet?.match(/\u0001refund\u0002/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run the integration suite**

Run: `bun run test:integration`
Expected: ALL tests PASS, including the three new ones. If the fragment test fails on the `" … "` assertion, the two matches landed in one fragment — double the filler count rather than weakening the assertion.

- [ ] **Step 4: Commit**

```bash
git add tests-integration/transcript-search.test.ts
git commit -m "Integration-test ts_headline snippet content (stemming, phrases, fragments)"
```

---

### Task 3: Types — `AgentSessionRow.match_snippet`

**Files:**
- Modify: `packages/ui/registry/new-york/observability-types/types.ts` (the `AgentSessionRow` interface)
- Copy to: `frontend/src/lib/observability-types.ts`

- [ ] **Step 1: Add the field**

In `packages/ui/registry/new-york/observability-types/types.ts`, inside `interface AgentSessionRow` (add as the last field of the interface, after the `tags?: SessionTag[]` line):

```ts
  /** Transcript excerpt for the active ?q= search; present only on list
   * rows fetched with a search. Matched words are wrapped in \u0001/\u0002
   * control-char markers (see TS_HEADLINE_OPTIONS in src/index.ts) — split
   * on them to render highlights; never treat as HTML. */
  match_snippet?: string | null
```

- [ ] **Step 2: Copy verbatim to the frontend**

```bash
cp packages/ui/registry/new-york/observability-types/types.ts frontend/src/lib/observability-types.ts
git diff --stat -- frontend/src/lib/observability-types.ts   # confirm only this change
```

- [ ] **Step 3: Typecheck the frontend**

Run: `cd frontend && bun run build && cd ..`
Expected: `tsc -b` and `vite build` succeed.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/registry/new-york/observability-types/types.ts frontend/src/lib/observability-types.ts
git commit -m "Add match_snippet to AgentSessionRow"
```

---

### Task 4: `ObsDataTable` — generic `renderRowDetail` sub-row

**Files:**
- Modify: `packages/ui/registry/new-york/data-table/obs-data-table.tsx`
- Copy to: `frontend/src/components/data-table/obs-data-table.tsx`

- [ ] **Step 1: Implement the prop**

In `packages/ui/registry/new-york/data-table/obs-data-table.tsx`:

(a) Change the react imports at the top — `Fragment` is a value import, the existing namespace import is type-only:

```ts
import { Fragment } from "react";
import type * as React from "react";
```

(b) Add to `ObsDataTableProps<TData>` (after `loading?: boolean;`):

```ts
  /** Optional full-width detail line rendered under a data row (e.g. a
   *  search-match snippet). Only rows where this returns non-null get the
   *  extra line; it shares the parent row's click handling so the pair
   *  reads as one clickable unit. */
  renderRowDetail?: (row: Row<TData>) => React.ReactNode;
```

(c) Destructure it in the component signature (after `loading,`):

```ts
  renderRowDetail,
```

(d) Replace the final `rows.map((row) => ( … ))` block in the body with:

```tsx
              rows.map((row) => {
                const detail = renderRowDetail?.(row) ?? null;
                const handleClick = onRowClick
                  ? (e: React.MouseEvent) => {
                      const t = e.target as HTMLElement;
                      if (t.closest('button, a, input, select, [role="menuitem"]')) return;
                      onRowClick(row);
                    }
                  : undefined;
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsSelected() ? "selected" : undefined}
                      className={cn(
                        onRowClick && "cursor-pointer hover:bg-muted/50",
                        // The detail line belongs to this row — drop the
                        // divider between them so they read as one unit.
                        detail != null && "border-b-0",
                      )}
                      onClick={handleClick}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {detail != null && (
                      <TableRow
                        className={cn(onRowClick && "cursor-pointer hover:bg-muted/50")}
                        onClick={handleClick}
                      >
                        <TableCell
                          colSpan={row.getVisibleCells().length}
                          className="pt-0 pb-2.5"
                        >
                          {detail}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
```

- [ ] **Step 2: Copy verbatim to the frontend**

```bash
cp packages/ui/registry/new-york/data-table/obs-data-table.tsx frontend/src/components/data-table/obs-data-table.tsx
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && bun run build && cd ..`
Expected: clean build (no behavior change yet — no caller passes the prop).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/registry/new-york/data-table/obs-data-table.tsx frontend/src/components/data-table/obs-data-table.tsx
git commit -m "ObsDataTable: optional renderRowDetail sub-row"
```

---

### Task 5: Sessions list — snippet sub-row while searching

**Files:**
- Modify: `packages/ui/registry/new-york/sessions-page/sessions-page.tsx`
- Copy to: `frontend/src/components/sessions-page.tsx`

- [ ] **Step 1: Implement**

In `packages/ui/registry/new-york/sessions-page/sessions-page.tsx`:

(a) Extend the lucide import:

```ts
import { CornerDownRight, Trash2 } from 'lucide-react'
```

(b) Add a module-scope helper above the `TRANSPORT_OPTIONS` constant:

```tsx
/** Server-marked snippet → React nodes. /api/sessions wraps matched words
 * in \u0001/\u0002 control chars (TS_HEADLINE_OPTIONS in src/index.ts);
 * splitting on them here keeps everything plain text nodes — the snippet
 * is user speech and must never be parsed as HTML. */
const SNIPPET_MARK = /\u0001([\s\S]*?)\u0002/g

const snippetNodes = (snippet: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = []
  let last = 0
  for (const m of snippet.matchAll(SNIPPET_MARK)) {
    // RegExpMatchArray.index is optional in some TS lib versions; matchAll
    // always sets it, so default defensively rather than assert.
    const idx = m.index ?? 0
    if (idx > last) nodes.push(snippet.slice(last, idx))
    nodes.push(
      <mark
        key={idx}
        className="rounded-[2px] bg-warning-bg px-0.5 font-medium text-warning-fg"
      >
        {m[1]}
      </mark>,
    )
    last = idx + m[0].length
  }
  if (last < snippet.length) nodes.push(snippet.slice(last))
  return nodes
}
```

Also add the type-only react import if not present:

```ts
import type * as React from 'react'
```

(c) Inside the component, under the existing `const [q] = useQueryState(…)` line:

```ts
  const searchActive = q.trim().length > 0
```

(d) Extend the `<ObsDataTable …/>` call with the new prop (after `loading={loading}`):

```tsx
        renderRowDetail={
          searchActive
            ? (row) =>
                row.original.match_snippet ? (
                  <div className="flex min-w-0 items-baseline gap-1.5 pl-8 text-xs text-muted-foreground">
                    <CornerDownRight size={12} className="shrink-0 translate-y-0.5" />
                    <span className="min-w-0 truncate">
                      …{snippetNodes(row.original.match_snippet)}…
                    </span>
                  </div>
                ) : null
            : undefined
        }
```

- [ ] **Step 2: Copy verbatim to the frontend**

```bash
cp packages/ui/registry/new-york/sessions-page/sessions-page.tsx frontend/src/components/sessions-page.tsx
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && bun run build && cd ..`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/registry/new-york/sessions-page/sessions-page.tsx frontend/src/components/sessions-page.tsx
git commit -m "Sessions list: match snippet sub-row while a transcript search is active"
```

---

### Task 6: `SessionDetailPage` — accept and thread `searchQuery`

**Files:**
- Modify: `packages/ui/registry/new-york/session-detail-page/session-detail-page.tsx`
- Copy to: `frontend/src/components/session-detail-page.tsx`

Note: this task only threads the prop; `TurnTranscriptSection` gains the matching prop in Task 7. Do Tasks 6 and 7 in order and typecheck after Task 7 — the intermediate state passes an unknown prop. (Alternative: implement 7 first. Either order is fine as long as the typecheck step runs after both.)

- [ ] **Step 1: Implement**

Change the component signature from:

```tsx
export const SessionDetailPage = () => {
```

to:

```tsx
export const SessionDetailPage = ({
  searchQuery,
}: {
  /** Active transcript-search query carried from the sessions list (?q=).
   * Threaded to the transcript so it can annotate matches. */
  searchQuery?: string
} = {}) => {
```

and change the transcript render from `<TurnTranscriptSection />` to:

```tsx
            <TurnTranscriptSection searchQuery={searchQuery} />
```

- [ ] **Step 2: Copy verbatim to the frontend**

```bash
cp packages/ui/registry/new-york/session-detail-page/session-detail-page.tsx frontend/src/components/session-detail-page.tsx
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/registry/new-york/session-detail-page/session-detail-page.tsx frontend/src/components/session-detail-page.tsx
git commit -m "SessionDetailPage: thread optional searchQuery to the transcript"
```

---

### Task 7: `TurnTranscriptSection` — highlight matches and scroll to the first

**Files:**
- Modify: `packages/ui/registry/new-york/turn-transcript/turn-transcript.tsx`
- Copy to: `frontend/src/components/turn-transcript.tsx`

- [ ] **Step 1: Implement**

In `packages/ui/registry/new-york/turn-transcript/turn-transcript.tsx`:

(a) Extend the react import:

```ts
import { Fragment, useEffect, useMemo, useRef } from 'react'
```

(b) Add module-scope helpers below the `PILL_BASE` constant:

```tsx
// ── Search-match annotation ──────────────────────────────────────────
// The sessions list filters with Postgres websearch_to_tsquery; opening a
// session from an active search carries the query here so the transcript
// can annotate what (approximately) matched. Postgres does real English
// stemming — this is a deliberate client-side approximation (shared stem
// prefix after stripping common suffixes), good enough to point the eye.
// The list snippet stays the server-truth for what matched.

const STEM_SUFFIXES = ['ations', 'ation', 'ings', 'ing', 'ions', 'ion', 'ed', 'es', 'ly', 's']

const crudeStem = (word: string): string => {
  for (const suffix of STEM_SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length)
    }
  }
  return word
}

/** Words worth highlighting from a websearch-style query: quoted phrases
 * contribute their words; `-excluded` terms and bare or/and are dropped. */
const parseSearchTerms = (q: string | undefined): string[] => {
  if (!q) return []
  return q
    .replace(/"/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !w.startsWith('-'))
    .map((w) => w.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase())
    .filter((w) => w.length >= 2 && w !== 'or' && w !== 'and')
}

const wordMatchesTerm = (word: string, term: string): boolean => {
  const a = crudeStem(word.toLowerCase())
  const b = crudeStem(term)
  if (a === b) return true
  return (b.length >= 3 && a.startsWith(b)) || (a.length >= 3 && b.startsWith(a))
}

/** Capture group keeps word tokens at odd indices of split() so the
 * renderer tests only words and passes punctuation through untouched. */
const WORD_TOKEN = /(\p{L}[\p{L}\p{N}']*)/gu

const textHasMatch = (text: string, terms: string[]): boolean => {
  if (!terms.length) return false
  const words = text.match(WORD_TOKEN)
  return !!words?.some((w) => terms.some((t) => wordMatchesTerm(w, t)))
}

const HighlightedText = ({ text, terms }: { text: string; terms: string[] }) => {
  if (!terms.length) return <>{text}</>
  return (
    <>
      {text.split(WORD_TOKEN).map((tok, i) =>
        i % 2 === 1 && terms.some((t) => wordMatchesTerm(tok, t)) ? (
          <mark key={i} className="rounded-[2px] bg-warning-bg px-0.5 text-warning-fg">
            {tok}
          </mark>
        ) : (
          <Fragment key={i}>{tok}</Fragment>
        ),
      )}
    </>
  )
}
```

(c) `TurnCard`: add `searchTerms` to the props —

```tsx
const TurnCard = ({ turn, highlighted, turnRef, alignment = 'chat', searchTerms = [] }: { turn: TurnRecord; highlighted?: boolean; turnRef?: React.Ref<HTMLDivElement>; alignment?: TranscriptAlignment; searchTerms?: string[] }) => {
```

and swap the two bubble text spans:

```tsx
                  <span className="text-xs"><HighlightedText text={turn.user_text} terms={searchTerms} /></span>
```

(for the user bubble — replaces `<span className="text-xs">{turn.user_text}</span>`), and

```tsx
                <span className="text-xs"><HighlightedText text={turn.agent_text} terms={searchTerms} /></span>
```

(for the agent bubble — replaces `<span className="text-xs">{turn.agent_text}</span>`).

(d) `ChatMessageCard` (raw fallback view): add the prop and highlight the content —

```tsx
const ChatMessageCard = ({ item, searchTerms = [] }: { item: ChatItem; searchTerms?: string[] }) => {
```

and replace `<p className="text-xs leading-relaxed">{content}</p>` with:

```tsx
        <p className="text-xs leading-relaxed"><HighlightedText text={content} terms={searchTerms} /></p>
```

(e) `TurnTranscriptSection`: add the prop —

```tsx
export const TurnTranscriptSection = ({
  chatHistory: chatHistoryProp,
  metrics: metricsProp,
  highlightedTurn: highlightedTurnProp,
  embedded,
  alignment = 'chat',
  searchQuery,
}: {
  chatHistory?: ChatItem[] | null
  metrics?: SessionMetrics | null
  highlightedTurn?: number | null
  embedded?: boolean
  alignment?: TranscriptAlignment
  /** Active transcript-search query (?q=) — highlights matching words and
   * scrolls to the first matching turn. */
  searchQuery?: string
}) => {
```

then, after the existing `highlightedTurn` scroll effect, add:

```tsx
  const searchTerms = useMemo(() => parseSearchTerms(searchQuery), [searchQuery])

  // Jump to the first matching turn when arriving from a search. An
  // explicit highlightedTurn deep-link wins; this only fills the gap.
  const turns = metrics?.turns
  useEffect(() => {
    if (!searchTerms.length || highlightedTurn != null) return
    const first = turns?.find((t) =>
      [t.user_text, t.agent_text].some((txt) => txt && textHasMatch(txt, searchTerms)),
    )
    if (first) {
      turnRefs.current[first.turn_number]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [searchTerms, highlightedTurn, turns])
```

(f) Pass the terms down — in the structured view:

```tsx
              <TurnCard
                turn={turn}
                highlighted={highlightedTurn === turn.turn_number}
                turnRef={(el) => { turnRefs.current[turn.turn_number] = el }}
                alignment={alignment}
                searchTerms={searchTerms}
              />
```

and in the raw fallback view:

```tsx
            <ChatMessageCard key={item.id || i} item={item} searchTerms={searchTerms} />
```

> **Tuning note (product decision, not a blocker):** `STEM_SUFFIXES` and the
> `wordMatchesTerm` prefix rule control highlight aggressiveness (e.g. should
> "order" light up "ordered"? — currently yes). The defaults above are
> reasonable; Amal may want to tune them after seeing real transcripts.

- [ ] **Step 2: Copy verbatim to the frontend**

```bash
cp packages/ui/registry/new-york/turn-transcript/turn-transcript.tsx frontend/src/components/turn-transcript.tsx
```

- [ ] **Step 3: Typecheck (covers Task 6's threaded prop too)**

Run: `cd frontend && bun run build && cd ..`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/registry/new-york/turn-transcript/turn-transcript.tsx frontend/src/components/turn-transcript.tsx
git commit -m "Transcript: highlight search matches and scroll to the first matching turn"
```

---

### Task 8: App routing — carry `?q=` from list to detail

**Files:**
- Modify: `frontend/src/App.tsx` (`AgentDetailRoute` and `SessionDetailRoute`) — frontend-only, NOT registry-shared.

- [ ] **Step 1: Implement**

(a) `AgentDetailRoute` — read the active search from the current URL and append it when navigating to a session (replace the existing function):

```tsx
function AgentDetailRoute() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  if (!agentId) return null
  // URL carries only the agent_id. When the same agent_id exists under
  // multiple accounts (rare; only when agent_ids are slugs rather than
  // UUIDs), the server returns the most-recently-active row.
  const encoded = encodeURIComponent(decodeURIComponent(agentId))
  // Carry the active transcript search (?q=) into the session detail URL
  // so the transcript can annotate matches.
  const q = new URLSearchParams(location.search).get('q')
  const qSuffix = q ? `?q=${encodeURIComponent(q)}` : ''
  return (
    <AgentDetailPage
      agentId={decodeURIComponent(agentId)}
      onSessionClick={(id) => navigate(`/agents/${encoded}/sessions/${id}${qSuffix}`)}
      onRunClick={(runId) => navigate(`/agents/${encoded}/simulation-evals/${runId}`)}
      onCompare={(runIdA, runIdB) =>
        navigate(`/agents/${encoded}/simulation-evals/compare?runA=${runIdA}&runB=${runIdB}`)
      }
    />
  )
}
```

(`useLocation` is already imported in App.tsx — verify, it's used by `EvalRunCompareRoute`.)

(b) `SessionDetailRoute` — read `?q=` and pass it down (replace the existing function):

```tsx
function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const params = new URLSearchParams(useLocation().search)
  const searchQuery = params.get('q') ?? undefined
  const decoded = sessionId ? decodeURIComponent(sessionId) : undefined
  return (
    <AgentObservabilityProvider baseUrl="/api" sessionId={decoded}>
      <SessionDetailPage searchQuery={searchQuery} />
    </AgentObservabilityProvider>
  )
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd frontend && bun run build && bun run lint && cd ..`
Expected: clean build, no new lint errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "Carry active transcript search query from sessions list to session detail"
```

---

### Task 9: Registry build + full verification

**Files:**
- Regenerate: `packages/ui/public/r/*.json` (via build)

- [ ] **Step 1: Regenerate registry JSON**

```bash
cd packages/ui && bun run build && cd ../..
git status --short packages/ui/public/r/
```
Expected: regenerated JSON for `observability-types`, `data-table`, `sessions-page`, `session-detail-page`, `turn-transcript` (and any items that inline them).

- [ ] **Step 2: Verify the sharing contract**

```bash
diff packages/ui/registry/new-york/observability-types/types.ts frontend/src/lib/observability-types.ts
diff packages/ui/registry/new-york/data-table/obs-data-table.tsx frontend/src/components/data-table/obs-data-table.tsx
diff packages/ui/registry/new-york/sessions-page/sessions-page.tsx frontend/src/components/sessions-page.tsx
diff packages/ui/registry/new-york/session-detail-page/session-detail-page.tsx frontend/src/components/session-detail-page.tsx
diff packages/ui/registry/new-york/turn-transcript/turn-transcript.tsx frontend/src/components/turn-transcript.tsx
grep -rn "packages/" frontend/src/ --include='*.ts' --include='*.tsx'
```
Expected: every `diff` empty; `grep` matches only JSDoc URL comments.

- [ ] **Step 3: Full test + build sweep**

```bash
bun test ./tests/
bun run test:integration
cd frontend && bun run build && bun run lint && cd ..
```
Expected: unit tests — only the known baseline failure; integration — all pass; frontend — clean build + lint.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/public/r/
git commit -m "Regenerate registry JSON for snippet/annotation changes"
```

---

### Task 10: Manual browser verification

**Files:** none (verification only)

- [ ] **Step 1: Run the stack**

```bash
docker compose up postgres -d
bun run dev            # API on :9090
bun run dev:frontend   # Vite on :5173
```

- [ ] **Step 2: Verify, using a word that exists in seeded/local session transcripts**

1. Sessions list → type a search term: matching rows show the snippet sub-row with highlighted words; clearing the search removes the sub-rows.
2. Quoted phrase and `-exclusion` queries still filter and the snippet reflects them.
3. Click a matching row: URL carries `?q=`, the transcript highlights the matched words, and the view scrolls to the first matching turn.
4. Open the same session directly (no `?q=`): transcript renders unannotated, no scroll jump.
5. Dark mode: highlight (`bg-warning-bg` / `text-warning-fg`) stays legible in both themes.

- [ ] **Step 3: Record any visual polish tweaks as follow-up edits (registry-first, re-copy, re-build) before opening the PR.**

---

## PR notes

- Branch: `transcript-search-ux` → PR against `main`.
- The PR touches `packages/ui/**` → apply notes-filter label `agent-observability-ui` (`gh pr edit <n> --add-label agent-observability-ui`; if the token lacks permission, list the label in the PR description instead).
- PR body footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)` (allowed at PR level; no Co-Authored-By in commits).
