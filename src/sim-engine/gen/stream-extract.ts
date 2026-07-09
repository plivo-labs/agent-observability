// Incremental extractor for the writer's streamed JSON response.
//
// The writer LLM streams `{"agent_flow_description": "...", "scenario_items": [
// {...}, {...}, ...]}` token by token. Historically AO accumulated the whole
// stream and parsed once at the end — every scenario became visible only when
// the slowest chunk finished. This scanner watches the accumulating text and
// surfaces each `scenario_items` element THE MOMENT its object closes in the
// stream, so scenarios can be validated + emitted mid-call.
//
// Fail-safe by design: this is an OPTIMISTIC reader layered in front of the
// authoritative end-of-stream parse (completeJSON's JSON.parse + Zod). On any
// internal inconsistency — an element that isn't an object, an element that
// fails JSON.parse, a runaway buffer — the extractor permanently disables
// itself for the rest of the stream and never throws into the LLM read loop.
// Worst case is exactly the pre-incremental behavior (everything arrives at
// final parse).
//
// Pure: no config, no I/O, no LLM knowledge — just a character-level JSON
// scanner (string/escape aware, brace/bracket depth) fed by arbitrary deltas
// (an item may be split across any number of pushes, including mid-escape).

type Dict = Record<string, any>;

/** Buffer sanity cap: a single scenario item should be a few KB; if a capture
 *  grows past this, the stream is malformed — disable rather than balloon. */
const MAX_CAPTURE_BYTES = 2_000_000;

/** scenario_items elements sit at depth 2 by construction: root object (1) →
 *  the items array (2). The `awaiting === "items"` transition is only taken at
 *  depth 1, so the array's depth is invariant. */
const ITEMS_DEPTH = 2;

/** Extractor lifecycle: before the root `{` → scanning inside it → root closed
 *  (trailing bytes ignored) → gave up (final parse remains the authority). */
type Phase = "pre" | "open" | "done" | "disabled";

export class WriterStreamExtractor {
  /** Root-level `agent_flow_description` value, once its string completes.
   *  Null until seen (the writer schema orders it before scenario_items, but
   *  the scanner does not rely on that). */
  description: string | null = null;

  private readonly onItem: (item: Dict) => void;
  private phase: Phase = "pre";

  // ── character-scanner state (persists across push() boundaries) ──────────────
  private inString = false;
  private escape = false;
  private depth = 0; // combined {} / [] nesting depth

  /** Root-level (depth 1) string capture — a key, or the description value. */
  private rootStringRaw: string | null = null;
  /** A depth-1 string just closed; if the next structural char is ':', it was a key. */
  private pendingKey: string | null = null;
  /** What the NEXT root-level value means. Set by ':' after a recognized key and
   *  cleared by the start of ANY value token — so a non-string description value
   *  (e.g. null) can never leave a stale binding that mis-captures the next key. */
  private awaiting: "description" | "items" | null = null;

  // scenario_items array state.
  private inItems = false;
  private itemRaw: string | null = null; // raw text of the item object being captured

  constructor(onItem: (item: Dict) => void) {
    this.onItem = onItem;
  }

  /** True once the extractor has given up; callers may skip feeding it. */
  get isDisabled(): boolean {
    return this.phase === "disabled";
  }

  push(delta: string): void {
    if (this.phase === "disabled" || this.phase === "done") return;
    try {
      for (let i = 0; i < delta.length; i++) {
        this.feed(delta[i]);
        if (this.phase === "disabled" || this.phase === "done") return;
      }
    } catch {
      // Any surprise (including an onItem callback throwing) disables the
      // optimistic path; the final parse remains the authority.
      this.phase = "disabled";
    }
  }

  private feed(ch: string): void {
    // Item capture appends every char verbatim (structural chars included) so the
    // completed slice is exactly the item's JSON text.
    if (this.itemRaw !== null) {
      this.itemRaw += ch;
      if (this.itemRaw.length > MAX_CAPTURE_BYTES) {
        this.phase = "disabled";
        return;
      }
    }

    if (this.inString) {
      if (this.escape) {
        this.escape = false;
        if (this.rootStringRaw !== null) this.rootStringRaw += ch;
        return;
      }
      if (ch === "\\") {
        this.escape = true;
        if (this.rootStringRaw !== null) this.rootStringRaw += ch;
        return;
      }
      if (ch === '"') {
        this.inString = false;
        if (this.rootStringRaw !== null) this.finishRootString();
        return;
      }
      if (this.rootStringRaw !== null) {
        this.rootStringRaw += ch;
        if (this.rootStringRaw.length > MAX_CAPTURE_BYTES) this.phase = "disabled";
      }
      return;
    }

    switch (ch) {
      case '"':
        if (this.inItems && this.depth === ITEMS_DEPTH && this.itemRaw === null) {
          this.phase = "disabled"; // string element in scenario_items — not the writer shape
          return;
        }
        this.inString = true;
        // Capture only strings sitting directly in the root object (keys, or the
        // description value) — strings nested inside other values are at depth ≥ 2,
        // and strings inside a captured item are already handled by itemRaw.
        if (this.depth === 1 && !this.inItems && this.itemRaw === null) this.rootStringRaw = "";
        return;
      case "{":
      case "[": {
        if (this.phase === "pre") {
          if (ch === "{") {
            this.phase = "open";
          } else {
            this.phase = "disabled"; // root is not an object — not the writer shape
            return;
          }
        } else if (this.awaiting === "items" && ch === "[" && this.depth === 1) {
          this.inItems = true;
        } else if (this.inItems && this.depth === ITEMS_DEPTH && this.itemRaw === null) {
          if (ch === "{") {
            this.itemRaw = "{"; // start of a scenario_items element
          } else {
            this.phase = "disabled"; // array element that isn't an object
            return;
          }
        }
        this.awaiting = null; // a value token started — any pending binding is resolved
        this.depth += 1;
        this.pendingKey = null;
        return;
      }
      case "}":
      case "]": {
        this.depth -= 1;
        if (this.depth < 0) {
          this.phase = "disabled";
          return;
        }
        // An item object just closed (back at array level)?
        if (this.itemRaw !== null && this.inItems && this.depth === ITEMS_DEPTH) {
          this.emitItem();
          return;
        }
        // The scenario_items array itself closed?
        if (this.inItems && ch === "]" && this.depth === ITEMS_DEPTH - 1) {
          this.inItems = false;
          return;
        }
        if (this.phase === "open" && this.depth === 0) this.phase = "done"; // root closed
        this.pendingKey = null;
        return;
      }
      case ":":
        if (this.depth === 1 && this.pendingKey !== null) {
          if (this.pendingKey === "agent_flow_description") this.awaiting = "description";
          else if (this.pendingKey === "scenario_items") this.awaiting = "items";
          this.pendingKey = null;
        }
        return;
      default: {
        const isWs = ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
        if (isWs || ch === ",") return;
        // A bare token (digit/literal) directly inside scenario_items — elements must
        // be objects; anything else means this isn't the writer shape.
        if (this.inItems && this.depth === ITEMS_DEPTH && this.itemRaw === null) {
          this.phase = "disabled";
          return;
        }
        // A non-string value token: resolves (and clears) any pending binding —
        // e.g. `"agent_flow_description": null` must not capture the NEXT string.
        this.awaiting = null;
        this.pendingKey = null;
        return;
      }
    }
  }

  /** A depth-1 string just completed: decode it and decide key vs value. */
  private finishRootString(): void {
    const raw = this.rootStringRaw!;
    this.rootStringRaw = null;
    let decoded: string;
    try {
      decoded = JSON.parse(`"${raw}"`) as string;
    } catch {
      this.phase = "disabled";
      return;
    }
    if (this.awaiting === "description") {
      this.description = decoded;
      this.awaiting = null;
      return;
    }
    this.awaiting = null; // a string value for some other key resolves the binding too
    this.pendingKey = decoded; // becomes a key iff the next structural char is ':'
  }

  private emitItem(): void {
    const raw = this.itemRaw!;
    this.itemRaw = null;
    let item: unknown;
    try {
      item = JSON.parse(raw);
    } catch {
      this.phase = "disabled";
      return;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      this.phase = "disabled";
      return;
    }
    this.onItem(item as Dict);
  }
}
