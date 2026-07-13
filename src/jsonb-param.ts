/** Version-proof jsonb parameter binding. bun's bun:sql changes how it
 *  serializes JS values bound to ::jsonb params across versions — 1.2.23
 *  turns a JS ARRAY into a PG array literal stored as a jsonb STRING scalar
 *  (invalid JSON), which corrupted chat_history in dev when the deploy base
 *  image bumped bun 1.2.14→1.2.23. Binding the JSON as TEXT and letting
 *  Postgres parse it (::text::jsonb) produces identical jsonb on every bun
 *  (verified 1.2.14 / 1.2.23 / 1.3.14). null/undefined stay SQL NULL.
 *  ALWAYS pair this with a ::text::jsonb cast in the query.
 *
 *  Standalone module (no imports) on purpose: unit suites mock ../db.js
 *  wholesale, and a helper re-exported from there would vanish inside every
 *  mocked test. */
export function jsonbParam(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v);
}
