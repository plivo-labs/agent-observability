# Transcript search snippets + in-transcript match annotation — design

Date: 2026-06-11
Status: approved (brainstorming session with Amal)
Origin: follow-up to the 2026-06-11 transcript-search design (PR #74),
which deliberately shipped without snippets. This adds the two UX
halves Amal asked for: match excerpts in the sessions list, and match
highlighting inside the transcript view.

Builds entirely on migration 018's `transcript_text` generated column
and the `websearch_to_tsquery` predicate — no new migrations, no new
endpoints, no new registry items.

## Decisions (made interactively)

| Question | Decision |
|---|---|
| List display while searching | Snippet under each matching row: a quieter full-width sub-row showing a short transcript excerpt with matched words highlighted. Disappears when search is cleared. (Rejected: snippet column, match-count banner.) |
| Transcript behavior when opened from a search | Matched words highlighted in message bubbles + auto-scroll to the first matching turn. (Rejected: highlight-only, full find-in-page navigator.) |
| Snippet generation | Server-side `ts_headline()` so excerpts use the exact tsquery the filter used — stemming, quoted phrases, and `-exclusions` agree by construction. (Rejected: client-side snippets — heavy payloads + JS stemming drift; separate snippet endpoint — extra round-trip.) |

## Part 1 — API: `match_snippet` on `GET /api/sessions`

- Only when `q` is present, the rows SELECT gains one column:

  ```sql
  ts_headline('english', transcript_text,
              websearch_to_tsquery('english', $q), $opts) AS match_snippet
  ```

  `$opts` is bound as a parameter:
  `StartSel=\x01, StopSel=\x02, MaxFragments=2, MaxWords=12, MinWords=6,
  FragmentDelimiter= … ` — control-character markers cannot occur in
  spoken transcript text and are never interpreted as HTML.
- Cost note: `ts_headline` runs only on the returned page (≤ 50 rows),
  never the full match set — the GIN-indexed predicate filters first.
- Without `q`, the column is absent from the SELECT entirely (the field
  is simply missing from row objects; the type marks it optional).
- The count query is untouched.

## Part 2 — Sessions list snippet sub-row

- `ObsDataTable` (registry item `data-table`) gains a generic optional
  prop `renderRowDetail?: (row: Row<TData>) => React.ReactNode`. When
  provided and it returns non-null for a row, an extra `TableRow`
  renders directly beneath that data row: one `TableCell` spanning all
  leaf columns, muted styling, and the same guarded `onRowClick`
  handling as the parent row so the pair reads as one clickable unit.
- `sessions-page` passes `renderRowDetail` only while `q` is active:
  it splits `match_snippet` on the `\x01`/`\x02` markers and renders
  matched segments as `<mark>`-styled spans (existing accent tokens,
  no `dangerouslySetInnerHTML` — pure React text nodes).
- `AgentSessionRow` (registry item `observability-types`) gains
  `match_snippet?: string | null`.

## Part 3 — Carrying `q` to the session detail page

- `frontend/src/App.tsx` only: `AgentDetailRoute`'s `onSessionClick`
  reads the active `?q=` from the current location and appends it to
  the session-detail URL it navigates to.
- No registry contract change — external consumers wire the same in
  their own router.

## Part 4 — Transcript annotation

- `SessionDetailPage` (registry item `session-detail-page`) gains an
  optional `searchQuery?: string` prop; `App.tsx`'s
  `SessionDetailRoute` reads `?q=` and passes it down.
- `TurnTranscriptSection` (registry item `turn-transcript`) gains the
  same optional prop and:
  - highlights matching words in user/agent bubbles in the structured
    turn view AND in the raw-chat fallback view, via `<mark>`-styled
    spans consistent with the list snippet;
  - auto-scrolls to the first matching turn using the existing
    `turnRefs` + `scrollIntoView` mechanism, only when no
    `highlightedTurn` is already requested (existing deep-links win).
- Client-side matching is a small word-prefix heuristic approximating
  Postgres English stemming: parse `q` (keep words from quoted
  phrases, drop `-excluded` terms and bare `or`), then highlight whole
  words sharing a stem-prefix with a query term. Known imperfection,
  accepted: the server-side snippet remains the source of truth for
  what matched; the transcript highlight is an annotation aid.

## Registry sharing contract

Touched registry items: `data-table`, `sessions-page`,
`observability-types`, `session-detail-page`, `turn-transcript`.
For each: edit `packages/ui/registry/new-york/<item>/` first, run
`cd packages/ui && bun run build`, commit regenerated `public/r/`,
copy verbatim to `frontend/src/**`. No new registry items → the docs
webpack-alias trap does not apply.

## Testing

- `tests/dashboard-api.test.ts` (mocked db): with `q`, the rows SQL
  contains `ts_headline` and binds the marker options param; without
  `q`, it does not.
- `tests-integration/transcript-search.test.ts` (real Postgres):
  `match_snippet` comes back with markers around stemmed matches
  ("cancel" query marks "cancelled" in the excerpt); quoted-phrase
  query; multi-fragment excerpts joined with " … "; field absent
  without `q`.
- Frontend has no test runner; verification is `tsc`/build + lint and
  a manual browser pass over: search active → snippet rows appear,
  click-through → transcript highlighted + scrolled, search cleared →
  no sub-rows, no `q` → detail page renders unannotated.

## Known limitations (recorded deliberately)

- Client-side highlight is a stemming approximation; an exact match of
  Postgres lexemes would require shipping lexeme positions from the
  server — not worth it for an annotation aid.
- OTLP-native sessions (transcript only in `raw_report->'events'`)
  remain unsearchable (inherited from the v1 search design), so they
  never show snippets either.
- Snippet shows up to 2 fragments; sessions with many scattered
  matches surface only the best two (ts_headline ranking).
