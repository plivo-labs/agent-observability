import type { RunEvent } from "./types.js";

export const MAX_CONTENT_CHARS = 10_000;
export const MAX_EVENTS_PER_CASE = 500;

/** Serialize LiveKit RunResult events into JSON-ready dicts. */
export function serializeEvents(rawEvents: unknown[] | null | undefined): RunEvent[] {
  if (!rawEvents || rawEvents.length === 0) return [];
  const out: RunEvent[] = [];
  for (const ev of rawEvents) {
    const serialized = serializeEvent(ev);
    if (serialized) out.push(serialized);
    if (out.length >= MAX_EVENTS_PER_CASE) break;
  }
  return out;
}

function serializeEvent(ev: unknown): RunEvent | null {
  if (!ev || typeof ev !== "object") return null;
  const type = (ev as { type?: string }).type;

  if (type === "message") {
    const item = (ev as { item?: any }).item ?? {};
    const role = item.role;
    let content = item.textContent ?? item.text_content ?? item.content;
    if (Array.isArray(content)) content = content.map(String).join("");
    const msg: import("./types.js").RunEventMessage = {
      type: "message",
      role,
      content: typeof content === "string" ? content : undefined,
      interrupted: Boolean(item.interrupted),
    };
    return trimContent(msg);
  }

  if (type === "function_call") {
    const item = (ev as { item?: any }).item ?? {};
    let args: unknown = item.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        // keep original string
      }
    }
    return {
      type: "function_call",
      name: item.name,
      arguments: args,
      call_id: item.call_id ?? item.callId ?? item.id,
    };
  }

  if (type === "function_call_output") {
    const item = (ev as { item?: any }).item ?? {};
    const out: import("./types.js").RunEventFunctionCallOutput = {
      type: "function_call_output",
      output: item.output,
      is_error: Boolean(item.is_error ?? item.isError),
      call_id: item.call_id ?? item.callId,
    };
    return trimOutput(out);
  }

  if (type === "agent_handoff") {
    const oldAgent = (ev as { old_agent?: any; oldAgent?: any }).old_agent
      ?? (ev as { oldAgent?: any }).oldAgent;
    const newAgent = (ev as { new_agent?: any; newAgent?: any }).new_agent
      ?? (ev as { newAgent?: any }).newAgent;
    return {
      type: "agent_handoff",
      from_agent: className(oldAgent),
      to_agent: className(newAgent),
    };
  }

  return null;
}

function className(obj: unknown): string | undefined {
  if (!obj) return undefined;
  const ctor = (obj as { constructor?: { name?: string } }).constructor;
  return ctor?.name;
}

function trimContent<T extends { content?: string }>(d: T): T {
  if (typeof d.content === "string" && d.content.length > MAX_CONTENT_CHARS) {
    d.content = d.content.slice(0, MAX_CONTENT_CHARS) + "…";
  }
  return d;
}

function trimOutput<T extends { output?: string }>(d: T): T {
  if (typeof d.output === "string" && d.output.length > MAX_CONTENT_CHARS) {
    d.output = d.output.slice(0, MAX_CONTENT_CHARS) + "…";
  }
  return d;
}
