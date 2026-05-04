export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] | null {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) {
    return null;
  }

  const strings = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : null;
}

function normalizeArray(value: unknown): unknown[] | null {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonValue(value);
  return isRecord(parsed) ? parsed : null;
}

function normalizeConversationItem(item: unknown): unknown {
  const record = normalizeRecord(item);
  if (!record) {
    return item;
  }

  const functionCall = normalizeRecord(record.function_call);
  if (functionCall) {
    return { ...functionCall, type: "function_call" };
  }

  const functionCallOutput = normalizeRecord(record.function_call_output);
  if (functionCallOutput) {
    return { ...functionCallOutput, type: "function_call_output" };
  }

  const handoff = normalizeRecord(record.agent_handoff);
  if (handoff) {
    return { ...handoff, type: "agent_handoff" };
  }

  return record;
}

function normalizeEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type !== "conversation_item_added" || !("item" in event)) {
    return event;
  }

  return {
    ...event,
    item: normalizeConversationItem(event.item),
  };
}

function normalizeEvents(value: unknown): Record<string, unknown>[] | null {
  const parsed = parseJsonValue(value);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const events: Record<string, unknown>[] = [];

  for (const item of values) {
    const normalized = parseJsonValue(item);
    if (Array.isArray(normalized)) {
      for (const nested of normalized) {
        const nestedEvent = normalizeRecord(nested);
        if (nestedEvent) {
          events.push(normalizeEvent(nestedEvent));
        }
      }
      continue;
    }

    if (isRecord(normalized)) {
      events.push(normalizeEvent(normalized));
    }
  }

  return events.length > 0 ? events : null;
}

function looksLikeChatItems(value: unknown[]): boolean {
  return value.length > 0 && value.every((item) => {
    const record = normalizeRecord(item);
    return !!record && (typeof record.type === "string" || typeof record.id === "string");
  });
}

export function normalizeRawReport(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonValue(value);
  if (parsed == null) {
    return null;
  }

  if (Array.isArray(parsed)) {
    if (looksLikeChatItems(parsed)) {
      return { items: parsed };
    }

    const merged: Record<string, unknown> = {};
    for (const item of parsed) {
      const normalized = normalizeRawReport(item);
      if (normalized) {
        const events = normalizeEvents(normalized.events);
        const { events: _events, ...rest } = normalized;
        Object.assign(merged, rest);
        if (events) {
          merged.events = [
            ...((Array.isArray(merged.events) ? merged.events : []) as unknown[]),
            ...events,
          ];
        }
      }
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (key === "events") {
      const events = normalizeEvents(raw);
      if (events) {
        out.events = events;
      }
      continue;
    }

    if (key === "options") {
      const options = normalizeRecord(raw);
      if (options) {
        out.options = options;
      }
      continue;
    }

    if (key === "tags") {
      const tags = normalizeStringArray(raw);
      if (tags) {
        out.tags = tags;
      }
      continue;
    }

    if (key === "usage") {
      const usage = normalizeArray(raw);
      if (usage) {
        out.usage = usage;
      }
      continue;
    }

    out[key] = parseJsonValue(raw);
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function normalizeRawReportPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return normalizeRawReport(patch) ?? {};
}
