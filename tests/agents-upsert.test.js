import { describe, test, expect, mock, beforeEach } from "bun:test";
// ── Mocks ───────────────────────────────────────────────────────────────────
//
// We exercise upsertAgent against a mocked sql tagged-template so the test
// can inspect the bound arguments without needing a real Postgres. The DB
// semantics (COALESCE on update, ON CONFLICT shape) are tested at the
// migration / SQL level by the integration tests, not here.
const sqlCalls = [];
// Tagged template mock that records (strings, ...values) on each call.
const mockSqlTag = mock((_strings, ...values) => {
    sqlCalls.push({ values });
    return Promise.resolve();
});
mock.module("../src/config.js", () => ({
    config: {
        DATABASE_URL: "postgres://test/test",
        PORT: 9090,
        AUTO_MIGRATE: false,
    },
}));
mock.module("../src/db.js", () => ({
    sql: mockSqlTag,
}));
// Import after mocks are wired.
const { upsertAgent, upsertAgentTx } = await import("../src/agents/upsert.js");
// ── upsertAgent ─────────────────────────────────────────────────────────────
describe("upsertAgent", () => {
    beforeEach(() => {
        sqlCalls.length = 0;
        mockSqlTag.mockClear();
    });
    test("inserts agent with explicit values", async () => {
        await upsertAgent({
            agentId: "abc",
            accountId: "acme",
            agentName: "Acme Bot",
        });
        expect(sqlCalls).toHaveLength(1);
        expect(sqlCalls[0].values).toEqual(["abc", "acme", "Acme Bot"]);
    });
    test("passes null accountId through (agents.account_id is nullable now)", async () => {
        await upsertAgent({ agentId: "abc", accountId: null });
        expect(sqlCalls[0].values).toEqual(["abc", null, null]);
    });
    test("passes undefined accountId through as null", async () => {
        await upsertAgent({ agentId: "abc" });
        expect(sqlCalls[0].values).toEqual(["abc", null, null]);
    });
    test("treats empty strings as null so COALESCE preserves existing values", async () => {
        await upsertAgent({ agentId: "abc", accountId: "", agentName: "" });
        expect(sqlCalls[0].values).toEqual(["abc", null, null]);
    });
    test("forwards non-empty agentName verbatim (last-writer-wins on update)", async () => {
        await upsertAgent({ agentId: "abc", accountId: "acme", agentName: "Renamed Bot" });
        expect(sqlCalls[0].values).toEqual(["abc", "acme", "Renamed Bot"]);
    });
    test("throws when agentId is empty string", async () => {
        await expect(upsertAgent({ agentId: "" })).rejects.toThrow("agentId is required");
        expect(sqlCalls).toHaveLength(0);
    });
    test("throws when agentId is not a string", async () => {
        await expect(
        // @ts-expect-error — testing runtime validation
        upsertAgent({ agentId: 123 })).rejects.toThrow("agentId is required");
        expect(sqlCalls).toHaveLength(0);
    });
    test("returns void (agent identity is agent_id; nothing to hand back)", async () => {
        const r = await upsertAgent({ agentId: "abc", accountId: "tenant-1" });
        expect(r).toBeUndefined();
    });
    test("passes null account_id through (column is nullable; COALESCE preserves existing)", async () => {
        await upsertAgent({ agentId: "abc", accountId: null });
        expect(sqlCalls[0].values).toEqual(["abc", null, null]);
    });
    test("real account_id is forwarded so it can overwrite a stored value", async () => {
        await upsertAgent({ agentId: "abc", accountId: "tenant-1" });
        expect(sqlCalls[0].values).toEqual(["abc", "tenant-1", null]);
    });
});
// ── upsertAgentTx ───────────────────────────────────────────────────────────
describe("upsertAgentTx", () => {
    beforeEach(() => {
        sqlCalls.length = 0;
        mockSqlTag.mockClear();
    });
    test("routes through the supplied transaction handle, not the shared sql tag", async () => {
        const txCalls = [];
        const tx = (_strings, ...values) => {
            txCalls.push(values);
            return Promise.resolve();
        };
        await upsertAgentTx(tx, {
            agentId: "abc",
            accountId: "acme",
            agentName: "Acme",
        });
        expect(txCalls).toHaveLength(1);
        expect(txCalls[0]).toEqual(["abc", "acme", "Acme"]);
        // The module-level sql tag must NOT be called — this would imply the
        // agent upsert escaped the transaction the caller set up.
        expect(sqlCalls).toHaveLength(0);
    });
    test("same null pass-through as upsertAgent", async () => {
        const txCalls = [];
        const tx = (_s, ...values) => {
            txCalls.push(values);
            return Promise.resolve();
        };
        await upsertAgentTx(tx, { agentId: "abc", accountId: null, agentName: "" });
        expect(txCalls[0]).toEqual(["abc", null, null]);
    });
    test("throws when agentId is missing", async () => {
        const tx = mock(() => Promise.resolve());
        await expect(upsertAgentTx(tx, { agentId: "" })).rejects.toThrow("agentId is required");
        expect(tx).not.toHaveBeenCalled();
    });
});
// ── Wiring check: helper is imported by ingest paths ───────────────────────
//
// Smoke tests that the modules consuming upsertAgent at least import
// cleanly. Catches "import path renamed but call site not updated"
// regressions without needing a full integration harness.
describe("ingest path wiring", () => {
    test("src/index.ts imports upsertAgent", async () => {
        const fs = await import("node:fs/promises");
        const src = await fs.readFile("src/index.ts", "utf8");
        expect(src).toContain('from "./agents/upsert.js"');
        expect(src).toContain("upsertAgent(");
    });
    test("src/evals/db.ts imports upsertAgentTx", async () => {
        const fs = await import("node:fs/promises");
        const src = await fs.readFile("src/evals/db.ts", "utf8");
        expect(src).toContain('from "../agents/upsert.js"');
        expect(src).toContain("upsertAgentTx(");
    });
    test("src/livekit/observability.ts imports upsertAgent", async () => {
        const fs = await import("node:fs/promises");
        const src = await fs.readFile("src/livekit/observability.ts", "utf8");
        expect(src).toContain('from "../agents/upsert.js"');
        expect(src).toContain("upsertAgent(");
    });
    test("src/db.ts (applySessionTagMetadata) imports upsertAgent", async () => {
        const fs = await import("node:fs/promises");
        const src = await fs.readFile("src/db.ts", "utf8");
        expect(src).toContain('from "./agents/upsert.js"');
        expect(src).toContain("upsertAgent(");
    });
});
