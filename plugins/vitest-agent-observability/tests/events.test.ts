import { describe, test, expect } from "vitest";
import { serializeEvents } from "../src/events.js";

describe("serializeEvents", () => {
  test("null/empty input returns []", () => {
    expect(serializeEvents(null)).toEqual([]);
    expect(serializeEvents([])).toEqual([]);
  });

  test("message event with text_content", () => {
    const ev = {
      type: "message",
      item: { role: "assistant", text_content: "hi", interrupted: false },
    };
    expect(serializeEvents([ev])).toEqual([
      { type: "message", role: "assistant", content: "hi", interrupted: false },
    ]);
  });

  test("message event with camelCase textContent", () => {
    const ev = { type: "message", item: { role: "user", textContent: "hello" } };
    const out = serializeEvents([ev]);
    expect(out[0]!.type).toBe("message");
    expect((out[0] as any).content).toBe("hello");
  });

  test("function_call parses JSON arguments", () => {
    const ev = {
      type: "function_call",
      item: { name: "lookup_order", arguments: '{"order_id":"12345"}', call_id: "c1" },
    };
    const out = serializeEvents([ev]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "function_call",
      name: "lookup_order",
      arguments: { order_id: "12345" },
      call_id: "c1",
    });
  });

  test("function_call keeps non-JSON arguments as string", () => {
    const ev = { type: "function_call", item: { name: "x", arguments: "not-json" } };
    const out = serializeEvents([ev]);
    expect((out[0] as any).arguments).toBe("not-json");
  });

  test("function_call_output", () => {
    const ev = {
      type: "function_call_output",
      item: { output: "ok", is_error: false, call_id: "c1" },
    };
    expect(serializeEvents([ev])).toEqual([
      { type: "function_call_output", output: "ok", is_error: false, call_id: "c1" },
    ]);
  });

  test("agent_handoff uses constructor names", () => {
    class AgentA {}
    class AgentB {}
    const ev = {
      type: "agent_handoff",
      item: {},
      old_agent: new AgentA(),
      new_agent: new AgentB(),
    };
    expect(serializeEvents([ev])).toEqual([
      { type: "agent_handoff", from_agent: "AgentA", to_agent: "AgentB" },
    ]);
  });

  test("unknown event type is passed through", () => {
    // Unknown kinds should land in the payload verbatim so the dashboard
    // can inspect their shape — no silent drops.
    const out = serializeEvents([{ type: "zzz", meta: "hello" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "zzz", meta: "hello" });
  });

  test("no event-count cap", () => {
    // Previously capped at 500; now all events survive.
    const events = Array.from({ length: 800 }, (_, i) => ({
      type: "message",
      item: { role: "user", text_content: `m${i}` },
    }));
    expect(serializeEvents(events)).toHaveLength(800);
  });

  test("long content preserved", () => {
    // Previously truncated at 10_000 chars; now preserved verbatim.
    const long = "x".repeat(20_000);
    const ev = { type: "message", item: { role: "assistant", text_content: long } };
    const out = serializeEvents([ev]);
    expect((out[0] as any).content).toBe(long);
  });
});
