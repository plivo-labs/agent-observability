import { describe, test, expect } from "bun:test";
import { parseTagImportRows } from "../src/tag-import.js";

// The generic session-tag importer's input contract: one JSON object per line,
// each naming a tag and how to find its session (a session_id, or an existing
// tag to match on). Used to backfill facts a platform recorded elsewhere — e.g.
// a `transfer:human` tag for calls that transferred before the runtime emitted
// it — without any platform-specific logic in this repo.

describe("parseTagImportRows", () => {
  test("parses one row per line, keeping metadata as an object", () => {
    const rows = parseTagImportRows(
      '{"session_id":"s1","name":"transfer:human","metadata":{"intent":"X"}}\n' +
        '\n' +
        '{"match_tag":"run_id:abc","name":"transfer:human"}\n',
    );
    expect(rows).toEqual([
      { session_id: "s1", match_tag: undefined, name: "transfer:human", metadata: { intent: "X" }, observed_at: null },
      { session_id: undefined, match_tag: "run_id:abc", name: "transfer:human", metadata: null, observed_at: null },
    ]);
  });

  test("rejects a row with no name, and a row with neither session_id nor match_tag", () => {
    expect(() => parseTagImportRows('{"session_id":"s1"}')).toThrow(/name/);
    expect(() => parseTagImportRows('{"name":"transfer:human"}')).toThrow(/session_id|match_tag/);
  });

  test("rejects malformed JSON with the line number", () => {
    expect(() => parseTagImportRows('{"session_id":"s1","name":"a"}\nnot json')).toThrow(/line 2/);
  });

  test("parses observed_at as a Date and rejects an invalid one", () => {
    const [row] = parseTagImportRows('{"session_id":"s1","name":"a","observed_at":"2026-08-10T12:00:00Z"}');
    expect(row.observed_at).toEqual(new Date("2026-08-10T12:00:00Z"));
    expect(() => parseTagImportRows('{"session_id":"s1","name":"a","observed_at":"yesterday"}')).toThrow(/observed_at/);
  });
});
