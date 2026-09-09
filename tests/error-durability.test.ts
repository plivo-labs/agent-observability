import { describe, test, expect } from "bun:test";
import { classifyErrorDurability } from "../src/error-durability.js";

// Bun's SQL.PostgresError shape: `code` is the wrapper class name, the real
// SQLSTATE rides in `errno` (verified empirically on bun 1.3.14 / PG 17).
const pgError = (errno: string) =>
  Object.assign(new Error("pg failure"), { code: "ERR_POSTGRES_SERVER_ERROR", errno });

describe("classifyErrorDurability", () => {
  test("Postgres SQLSTATE in errno classifies by class, not by the wrapper code", () => {
    expect(classifyErrorDurability(pgError("23505"))).toBe("deterministic"); // unique violation
    expect(classifyErrorDurability(pgError("22P05"))).toBe("deterministic"); // untranslatable char
    expect(classifyErrorDurability(pgError("42703"))).toBe("deterministic"); // undefined column
    expect(classifyErrorDurability(pgError("57P01"))).toBe("transient"); // admin shutdown
    expect(classifyErrorDurability(pgError("08006"))).toBe("transient"); // connection failure
  });

  test("non-SQLSTATE errno never masks the code path", () => {
    expect(classifyErrorDurability(Object.assign(new Error("x"), { code: "ETIMEDOUT", errno: -60 }))).toBe("transient");
    expect(classifyErrorDurability(Object.assign(new Error("x"), { code: "23505" }))).toBe("deterministic");
  });

  test("message-signal fallback unchanged", () => {
    expect(classifyErrorDurability(new Error("upstream 429 rate limit"))).toBe("transient");
    expect(classifyErrorDurability(new Error("duplicate key value violates"))).toBe("deterministic");
    expect(classifyErrorDurability(new Error("weird"))).toBe("unknown");
  });
});
