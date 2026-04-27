import type { RunEvent } from "./types.js";

/**
 * Serialize LiveKit RunResult events into JSON-ready dicts.
 *
 * Philosophy: do the *minimum* transformation needed to make the event
 * JSON-serializable, and pass everything else through untouched. No field
 * hand-picking, no truncation, no silent drops of unknown event types.
 *
 * The only transforms we apply:
 *  - Convert the event (and its nested `item`) to a plain dict, preserving
 *    every field — including `item.metrics`, timestamps, IDs, etc.
 *  - For `function_call`, parse `arguments` from JSON string → object as a
 *    convenience (so the dashboard doesn't have to).
 *  - For `agent_handoff`, replace the `old_agent` / `new_agent` instance
 *    references with their constructor names (full Agent objects aren't
 *    JSON-friendly).
 */
export function serializeEvents(rawEvents: unknown[] | null | undefined): RunEvent[] {
  if (!rawEvents || rawEvents.length === 0) return [];
  const out: RunEvent[] = [];
  for (const ev of rawEvents) {
    try {
      out.push(serializeEvent(ev));
    } catch {
      out.push({
        type: String((ev as any)?.type ?? "unknown"),
        _serialize_error: true,
        repr: String(ev),
      } as unknown as RunEvent);
    }
  }
  return out;
}

function serializeEvent(ev: unknown): RunEvent {
  const ev_dict = toPlainDict(ev);
  const type = (ev_dict as any).type ?? (ev as any)?.type;

  const rawItem = (ev as any)?.item;
  if (rawItem !== undefined) {
    (ev_dict as any).item = toPlainDict(rawItem);
  }
  const item = (ev_dict as any).item ?? {};

  if (type === "message") {
    let content = item.textContent ?? item.text_content ?? item.content;
    if (Array.isArray(content)) content = content.map(String).join("");
    setDefault(ev_dict, "role", item.role);
    setDefault(ev_dict, "content", typeof content === "string" ? content : undefined);
    setDefault(ev_dict, "interrupted", Boolean(item.interrupted));
    // Pass per-turn metrics through so the dashboard can render latency.
    if ("metrics" in item) setDefault(ev_dict, "metrics", item.metrics);
  } else if (type === "function_call") {
    // LiveKit Node's FunctionCall chat item stores the JSON-string args
    // under `args`, not `arguments`. Python's FunctionCall uses
    // `arguments`. Accept both so either SDK flavor produces a populated
    // payload instead of `arguments: undefined`.
    let args: unknown = item.arguments ?? item.args;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep original string */
      }
    }
    setDefault(ev_dict, "name", item.name);
    setDefault(ev_dict, "arguments", args);
    setDefault(ev_dict, "call_id", item.call_id ?? item.callId ?? item.id);
  } else if (type === "function_call_output") {
    setDefault(ev_dict, "output", item.output);
    setDefault(ev_dict, "is_error", Boolean(item.is_error ?? item.isError));
    setDefault(ev_dict, "call_id", item.call_id ?? item.callId);
  } else if (type === "agent_handoff") {
    const oldAgent =
      (ev as any)?.old_agent ?? (ev as any)?.oldAgent;
    const newAgent =
      (ev as any)?.new_agent ?? (ev as any)?.newAgent;
    (ev_dict as any).from_agent = className(oldAgent);
    (ev_dict as any).to_agent = className(newAgent);
    delete (ev_dict as any).old_agent;
    delete (ev_dict as any).oldAgent;
    delete (ev_dict as any).new_agent;
    delete (ev_dict as any).newAgent;
  }

  return ev_dict as unknown as RunEvent;
}

/** Best-effort conversion of any object to a plain JSON-friendly dict. */
function toPlainDict(obj: unknown): Record<string, unknown> {
  if (obj == null || typeof obj !== "object") return {};
  if (Array.isArray(obj)) return { ...obj };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    if (typeof v === "function") continue;
    out[k] = v;
  }
  return out;
}

function setDefault(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!(key in target)) target[key] = value;
}

function className(obj: unknown): string | undefined {
  if (!obj) return undefined;
  const ctor = (obj as { constructor?: { name?: string } }).constructor;
  return ctor?.name;
}
