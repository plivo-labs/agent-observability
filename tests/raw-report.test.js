import { describe, test, expect } from "bun:test";
import { normalizeRawReport, parseJsonValue } from "../src/raw-report.js";
describe("parseJsonValue", () => {
    test("returns non-string values unchanged", () => {
        expect(parseJsonValue(42)).toBe(42);
        expect(parseJsonValue(null)).toBe(null);
        expect(parseJsonValue(undefined)).toBe(undefined);
        expect(parseJsonValue(true)).toBe(true);
        const obj = { already: "parsed" };
        expect(parseJsonValue(obj)).toBe(obj);
    });
    test("parses JSON-shaped strings (object / array)", () => {
        expect(parseJsonValue('{"a":1}')).toEqual({ a: 1 });
        expect(parseJsonValue("[1,2,3]")).toEqual([1, 2, 3]);
    });
    test("leaves non-JSON-shaped strings as-is", () => {
        expect(parseJsonValue("hello")).toBe("hello");
        expect(parseJsonValue("42")).toBe("42");
        expect(parseJsonValue("")).toBe("");
    });
    test("returns the original string when the input looks like JSON but fails to parse", () => {
        expect(parseJsonValue("{ broken: ")).toBe("{ broken: ");
        expect(parseJsonValue("[1, 2,")).toBe("[1, 2,");
    });
    test("respects leading whitespace before deciding to parse", () => {
        expect(parseJsonValue('   {"a":1}')).toEqual({ a: 1 });
        expect(parseJsonValue("   plain text")).toBe("   plain text");
    });
});
describe("normalizeRawReport", () => {
    test("returns null for null and undefined", () => {
        expect(normalizeRawReport(null)).toBe(null);
        expect(normalizeRawReport(undefined)).toBe(null);
    });
    test("parses a JSON-string report", () => {
        expect(normalizeRawReport('{"options":{"max":3}}')).toEqual({ options: { max: 3 } });
    });
    test("returns null when given a primitive", () => {
        expect(normalizeRawReport(42)).toBe(null);
        expect(normalizeRawReport("not json")).toBe(null);
    });
    describe("array input — looksLikeChatItems heuristic", () => {
        test("wraps a clean array of chat items as { items: [...] }", () => {
            const items = [
                { id: "m1", type: "message", role: "user" },
                { id: "m2", type: "message", role: "assistant" },
            ];
            expect(normalizeRawReport(items)).toEqual({ items });
        });
        test("treats array of report fragments as merge targets, not chat items", () => {
            // Each element is a report-shaped object (no top-level type/id), so
            // looksLikeChatItems returns false and we merge instead.
            const fragments = [
                { options: { a: 1 } },
                { tags: ["lk.success"] },
            ];
            expect(normalizeRawReport(fragments)).toEqual({
                options: { a: 1 },
                tags: ["lk.success"],
            });
        });
        test("merges events arrays across fragments", () => {
            const fragments = [
                { events: [{ type: "conversation_item_added", item: { id: "i1" } }] },
                { events: [{ type: "conversation_item_added", item: { id: "i2" } }] },
            ];
            const result = normalizeRawReport(fragments);
            expect(result?.events).toEqual([
                { type: "conversation_item_added", item: { id: "i1" } },
                { type: "conversation_item_added", item: { id: "i2" } },
            ]);
        });
        test("returns null for an empty merge with no recognizable fields", () => {
            expect(normalizeRawReport([])).toBe(null);
            expect(normalizeRawReport([null, "not-an-object"])).toBe(null);
        });
    });
    describe("conversation item normalization", () => {
        test("hoists function_call payload and stamps type='function_call'", () => {
            const result = normalizeRawReport({
                events: [
                    {
                        type: "conversation_item_added",
                        item: {
                            function_call: {
                                id: "tool-1",
                                name: "lookup_order",
                                arguments: { order_id: "123" },
                            },
                        },
                    },
                ],
            });
            expect(result?.events).toEqual([
                {
                    type: "conversation_item_added",
                    item: {
                        id: "tool-1",
                        name: "lookup_order",
                        arguments: { order_id: "123" },
                        type: "function_call",
                    },
                },
            ]);
        });
        test("hoists function_call_output and stamps the correct type", () => {
            const result = normalizeRawReport({
                events: [
                    {
                        type: "conversation_item_added",
                        item: {
                            function_call_output: { id: "tool-1", output: "shipped" },
                        },
                    },
                ],
            });
            expect(result?.events?.[0].item).toEqual({
                id: "tool-1",
                output: "shipped",
                type: "function_call_output",
            });
        });
        test("hoists agent_handoff payload", () => {
            const result = normalizeRawReport({
                events: [
                    {
                        type: "conversation_item_added",
                        item: {
                            agent_handoff: { from: "greeter", to: "support" },
                        },
                    },
                ],
            });
            expect(result?.events?.[0].item).toEqual({
                from: "greeter",
                to: "support",
                type: "agent_handoff",
            });
        });
        test("leaves message items untouched (no function_call branch)", () => {
            const result = normalizeRawReport({
                events: [
                    {
                        type: "conversation_item_added",
                        item: { id: "m1", role: "user", content: "hi" },
                    },
                ],
            });
            expect(result?.events?.[0].item).toEqual({
                id: "m1",
                role: "user",
                content: "hi",
            });
        });
        test("does not touch non-conversation_item_added events", () => {
            const result = normalizeRawReport({
                events: [
                    { type: "speech_created", speech_id: "s1" },
                ],
            });
            expect(result?.events).toEqual([{ type: "speech_created", speech_id: "s1" }]);
        });
    });
    describe("special key handling", () => {
        test("parses a stringified events array", () => {
            const result = normalizeRawReport({
                events: '[{"type":"speech_created"}]',
            });
            expect(result?.events).toEqual([{ type: "speech_created" }]);
        });
        test("parses a stringified options object", () => {
            const result = normalizeRawReport({
                options: '{"max_tool_steps":3}',
            });
            expect(result?.options).toEqual({ max_tool_steps: 3 });
        });
        test("filters tags down to non-empty strings", () => {
            const result = normalizeRawReport({
                tags: ["lk.success", "", "lk.judge:pass", 42, null],
            });
            expect(result?.tags).toEqual(["lk.success", "lk.judge:pass"]);
        });
        test("drops tags entirely when none are valid strings", () => {
            const result = normalizeRawReport({ tags: [42, null, ""] });
            expect(result?.tags).toBeUndefined();
        });
        test("parses a stringified usage array", () => {
            const result = normalizeRawReport({
                usage: '[{"type":"llm_usage","input_tokens":10}]',
            });
            expect(result?.usage).toEqual([{ type: "llm_usage", input_tokens: 10 }]);
        });
        test("falls through to parseJsonValue for unknown keys", () => {
            const result = normalizeRawReport({
                agent_name: "support-agent",
                sdk_version: "1.5.2",
                custom_field: '{"nested":true}',
            });
            expect(result).toEqual({
                agent_name: "support-agent",
                sdk_version: "1.5.2",
                custom_field: { nested: true },
            });
        });
    });
    test("returns null for empty record", () => {
        expect(normalizeRawReport({})).toBe(null);
    });
});
