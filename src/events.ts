export function getEventCreatedAt(event: unknown): number | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as { created_at?: unknown }).created_at;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  return null;
}

export function sortSessionEvents(events: unknown): unknown {
  if (!Array.isArray(events)) return events ?? null;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const at = getEventCreatedAt(a.event);
      const bt = getEventCreatedAt(b.event);
      if (at == null && bt == null) return a.index - b.index;
      if (at == null) return 1;
      if (bt == null) return -1;
      return at - bt || a.index - b.index;
    })
    .map(({ event }) => event);
}
