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
// Worst case is exactly today's behavior (everything arrives at final parse).
//
// Pure: no config, no I/O, no LLM knowledge — just a character-level JSON
// scanner (string/escape aware, brace/bracket depth) fed by arbitrary deltas
// (an item may be split across any number of pushes, including mid-escape).

type Dict = Record<string, any>;

/** Buffer sanity cap: a single scenario item should be a few KB; if a capture
 *  grows past this, the stream is malformed — disable rather than balloon. */
const MAX_CAPTURE_BYTES = 2_000_000;

export class WriterStreamExtractor {
  /** Root-level `agent_flow_description` value, once its string completes.
   *  Null until seen (the writer schema orders it before scenario_items, but
   *  the scanner does not rely on that). */
  description: string | null = null;

  private readonly onItem: (item: Dict) => void;
  private disabled = false;
  private done = false;

  // ── character-scanner state (persists across push() boundaries) ──────────────
  private inString = false;
  private escape = false;
  private depth = 0; // combined {} / [] nesting depth
  private rootSeen = false;

  // Root-level (depth 1) string capture — a key, or the description value.
  private rootStringRaw: string | null = null;
  /** A depth-1 string just closed; if the next structural char is ':', it was a key. */
  private pendingKey: string | null = null;
  private awaitingDescriptionValue = false;
  private awaitingItemsArray = false;

  // scenario_items array state.
  private inItems = false;
  private itemsArrayDepth = 0; // depth value while directly inside the items array
  private itemRaw: string | null = null; // raw text of the item object being captured

  constructor(onItem: (item: Dict) => void) {
    this.onItem = onItem;
  }

  /** True once the extractor has given up; callers may skip feeding it. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  push(delta: string): void {
    if (this.disabled || this.done) return;
    try {
      for (let i = 0; i < delta.length; i++) {
        this.feed(delta[i]);
        if (this.disabled || this.done) return;
      }
    } catch {
      // Any surprise (including an onItem callback throwing) disables the
      // optimistic path; the final parse remains the authority.
      this.disabled = true;
    }
  }

  private feed(ch: string): void {
    // Item capture appends every char verbatim (structural chars included) so the
    // completed slice is exactly the item's JSON text.
    if (this.itemRaw !== null) {
      this.itemRaw += ch;
      if (this.itemRaw.length > MAX_CAPTURE_BYTES) {
        this.disabled = true;
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
        if (this.rootStringRaw.length > MAX_CAPTURE_BYTES) this.disabled = true;
      }
      return;
    }

    switch (ch) {
      case '"':
        if (this.inItems && this.depth === this.itemsArrayDepth && this.itemRaw === null) {
          this.disabled = true; // string element in scenario_items — not the writer shape
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
        if (!this.rootSeen) {
          if (ch === "{") {
            this.rootSeen = true;
          } else {
            this.disabled = true; // root is not an object — not the writer shape
            return;
          }
        } else if (this.awaitingItemsArray && ch === "[" && this.depth === 1) {
          this.inItems = true;
          this.awaitingItemsArray = false;
          this.itemsArrayDepth = this.depth + 1;
        } else if (this.inItems && this.depth === this.itemsArrayDepth && this.itemRaw === null) {
          if (ch === "{") {
            this.itemRaw = "{"; // start of a scenario_items element
          } else {
            this.disabled = true; // array element that isn't an object
            return;
          }
        }
        this.depth += 1;
        this.pendingKey = null;
        return;
      }
      case "}":
      case "]": {
        this.depth -= 1;
        if (this.depth < 0) {
          this.disabled = true;
          return;
        }
        // An item object just closed (back at array level)?
        if (this.itemRaw !== null && this.inItems && this.depth === this.itemsArrayDepth) {
          this.emitItem();
          return;
        }
        // The scenario_items array itself closed?
        if (this.inItems && ch === "]" && this.depth === this.itemsArrayDepth - 1) {
          this.inItems = false;
          return;
        }
        if (this.rootSeen && this.depth === 0) this.done = true; // root object closed
        this.pendingKey = null;
        return;
      }
      case ":":
        if (this.depth === 1 && this.pendingKey !== null) {
          if (this.pendingKey === "agent_flow_description") this.awaitingDescriptionValue = true;
          else if (this.pendingKey === "scenario_items") this.awaitingItemsArray = true;
          this.pendingKey = null;
        }
        return;
      default: {
        const isWs = ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
        // A bare token (digit/literal) directly inside scenario_items — elements must
        // be objects; anything else means this isn't the writer shape.
        if (!isWs && ch !== "," && this.inItems && this.depth === this.itemsArrayDepth && this.itemRaw === null) {
          this.disabled = true;
          return;
        }
        // Any non-colon token after a depth-1 string means that string was a VALUE.
        if (!isWs) this.pendingKey = null;
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
      this.disabled = true;
      return;
    }
    if (this.awaitingDescriptionValue) {
      this.description = decoded;
      this.awaitingDescriptionValue = false;
      return;
    }
    this.pendingKey = decoded; // becomes a key iff the next structural char is ':'
  }

  private emitItem(): void {
    const raw = this.itemRaw!;
    this.itemRaw = null;
    let item: unknown;
    try {
      item = JSON.parse(raw);
    } catch {
      this.disabled = true;
      return;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      this.disabled = true;
      return;
    }
    this.onItem(item as Dict);
  }
}
