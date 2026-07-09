import { describe, test, expect } from "bun:test";
import { WriterStreamExtractor } from "../src/sim-engine/gen/stream-extract.js";

type Dict = Record<string, any>;

const ITEM_A = { slot_id: "S001", scenario: { name: "A", goal: "g{a}", tags: ["x]y"] } };
const ITEM_B = { slot_id: "S002", scenario: { name: 'B "quoted" \\ back', goal: "g,:[b", nested: { deep: [1, 2, { z: "}" }] } } };
const ENVELOPE = { agent_flow_description: 'Refund agent: handles {refunds}, "quotes" and [brackets].', scenario_items: [ITEM_A, ITEM_B] };
const ENVELOPE_TEXT = JSON.stringify(ENVELOPE);

/** Run the extractor over `text` split into deltas of `size` chars. */
function run(text: string, size: number): { items: Dict[]; ex: WriterStreamExtractor } {
  const items: Dict[] = [];
  const ex = new WriterStreamExtractor((i) => items.push(i));
  for (let i = 0; i < text.length; i += size) ex.push(text.slice(i, i + size));
  return { items, ex };
}

describe("WriterStreamExtractor", () => {
  test("extracts every item and the description, at ANY delta granularity", () => {
    // Delta size 1 exercises every possible split point: mid-escape, mid-key,
    // mid-structural — the scanner state must survive all of them.
    for (const size of [1, 3, 16, ENVELOPE_TEXT.length]) {
      const { items, ex } = run(ENVELOPE_TEXT, size);
      expect(items).toEqual([ITEM_A, ITEM_B]); // byte-faithful item objects
      expect(ex.description).toBe(ENVELOPE.agent_flow_description);
      expect(ex.isDisabled).toBe(false);
    }
  });

  test("items emit AS they complete, before the envelope closes", () => {
    const items: Dict[] = [];
    const ex = new WriterStreamExtractor((i) => items.push(i));
    const firstItemEnd = ENVELOPE_TEXT.indexOf("}]") > -1 ? ENVELOPE_TEXT.indexOf('},{"slot_id":"S002"') + 1 : -1;
    ex.push(ENVELOPE_TEXT.slice(0, firstItemEnd));
    expect(items).toEqual([ITEM_A]); // first item already out, stream still open
    ex.push(ENVELOPE_TEXT.slice(firstItemEnd));
    expect(items).toEqual([ITEM_A, ITEM_B]);
  });

  test("pretty-printed JSON (whitespace/newlines everywhere) works", () => {
    const { items, ex } = run(JSON.stringify(ENVELOPE, null, 2), 7);
    expect(items).toEqual([ITEM_A, ITEM_B]);
    expect(ex.description).toBe(ENVELOPE.agent_flow_description);
  });

  test("scenario_items before agent_flow_description: items still emit; description captured late", () => {
    const reordered = `{"scenario_items": ${JSON.stringify([ITEM_A])}, "agent_flow_description": "late desc"}`;
    const items: Dict[] = [];
    const ex = new WriterStreamExtractor((i) => items.push(i));
    const itemsEnd = reordered.indexOf("],") + 1;
    ex.push(reordered.slice(0, itemsEnd));
    expect(items).toEqual([ITEM_A]);
    expect(ex.description).toBeNull(); // not seen yet — the writer falls back to the planner's text
    ex.push(reordered.slice(itemsEnd));
    expect(ex.description).toBe("late desc");
  });

  test("empty scenario_items array emits nothing and stays healthy", () => {
    const { items, ex } = run('{"agent_flow_description":"d","scenario_items":[]}', 4);
    expect(items).toEqual([]);
    expect(ex.isDisabled).toBe(false);
  });

  test("a non-object array element disables the extractor without throwing", () => {
    const { items, ex } = run('{"scenario_items":[42,{"slot_id":"S001"}]}', 3);
    expect(items).toEqual([]); // nothing emitted after the anomaly
    expect(ex.isDisabled).toBe(true);
  });

  test("a non-object root disables (not the writer shape)", () => {
    const { ex } = run('["not","an","object"]', 2);
    expect(ex.isDisabled).toBe(true);
  });

  test("a throwing onItem callback disables instead of propagating", () => {
    const ex = new WriterStreamExtractor(() => {
      throw new Error("consumer bug");
    });
    expect(() => ex.push(ENVELOPE_TEXT)).not.toThrow();
    expect(ex.isDisabled).toBe(true);
  });

  test("pushes after root close are ignored (done)", () => {
    const items: Dict[] = [];
    const ex = new WriterStreamExtractor((i) => items.push(i));
    ex.push(ENVELOPE_TEXT);
    ex.push('{"scenario_items":[{"slot_id":"S099"}]}'); // trailing garbage — a second doc must not emit
    expect(items).toEqual([ITEM_A, ITEM_B]);
  });

  test('"agent_flow_description": null does not mis-capture the next key as the description', () => {
    // The regression the review found: a non-string description value left the
    // awaiting flag dangling, so the NEXT root key ("scenario_items") was captured
    // as the description and the extractor silently emitted nothing.
    const nullDesc = `{"agent_flow_description": null, "scenario_items": [${JSON.stringify(ITEM_A)}]}`;
    for (const size of [1, 5, nullDesc.length]) {
      const { items, ex } = run(nullDesc, size);
      expect(items).toEqual([ITEM_A]); // items still emit
      expect(ex.description).toBeNull(); // and nothing bogus was captured
      expect(ex.isDisabled).toBe(false);
    }
  });

  test("other root keys with object/array values are traversed without confusion", () => {
    const withExtras = `{"meta":{"a":[1,{"b":"c"}]},"agent_flow_description":"d","scenario_items":[${JSON.stringify(ITEM_A)}],"tail":"end"}`;
    const { items, ex } = run(withExtras, 5);
    expect(items).toEqual([ITEM_A]);
    expect(ex.description).toBe("d");
    expect(ex.isDisabled).toBe(false);
  });
});
