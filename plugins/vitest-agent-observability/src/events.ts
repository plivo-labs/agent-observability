import type { RunEvent } from "./types.js";

/**
 * Serialize LiveKit RunResult events into JSON-ready dicts.
 *
 * No length or count caps — the dashboard needs the full trace. Unknown event
 * types are forwarded as `{ type, ...passthrough }` so future LiveKit event
 * kinds land in the UI without a plugin release.
 */
export function serializeEvents(rawEvents: unknown[] | null | undefined): RunEvent[] {
  if (!rawEvents || rawEvents.length === 0) return [];
  const out: RunEvent[] = [];
  for (const ev of rawEvents) {
    const serialized = serializeEvent(ev);
    if (serialized) out.push(serialized);
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
    return msg;
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
    return out;
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

  // Unknown event type — pass through so the dashboard still renders it.
  if (typeof type === "string") {
    return { ...(ev as object), type } as unknown as RunEvent;
  }

  return null;
}

function className(obj: unknown): string | undefined {
  if (!obj) return undefined;
  const ctor = (obj as { constructor?: { name?: string } }).constructor;
  return ctor?.name;
}
