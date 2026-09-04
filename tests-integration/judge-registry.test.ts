// Proves migration 024's seeded rows ARE the shipped prompts (the migration is
// generated, but this closes the loop against hand-edits to the SQL), and that
// the loader + override plumbing read them back verbatim from real Postgres.
import { describe, test, expect, beforeAll } from "bun:test";
import { describeDb } from "./helpers.js";
import { sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { DEFAULT_JUDGE_ROWS } from "../src/evals-engine/judge-catalogue.js";
import {
  loadJudgeRegistry,
  ensureJudgePromptOverrides,
  __resetJudgeRegistryCacheForTest,
} from "../src/evals-engine/judge-registry.js";
import { promptBody, promptOutput, promptSub, clearJudgePromptOverrides } from "../src/evals-engine/judges/judge-prompts.js";

describeDb("judge registry (real PG)", () => {
  beforeAll(async () => {
    await migrate(sql);
  });

  test("seeded default rows match the catalogue field by field", async () => {
    const rows = await loadJudgeRegistry();
    const defaults = rows.filter((r) => r.type === "default");
    expect(defaults.length).toBe(DEFAULT_JUDGE_ROWS.length);
    for (const want of DEFAULT_JUDGE_ROWS) {
      const got = defaults.find((r) => r.name === want.name);
      expect(got, want.name).toBeDefined();
      expect(got!.scope).toBe(want.scope);
      expect(got!.kind).toBe(want.kind);
      if (want.kind === "code") {
        expect(got!.prompt).toBeNull();
        continue;
      }
      // Field-by-field: jsonb does not preserve key order, byte-comparing JSON would lie.
      expect(got!.prompt!.body).toBe(want.prompt!.body);
      expect(got!.prompt!.output).toBe(want.prompt!.output);
      expect(got!.prompt!.slots ?? []).toEqual(want.prompt!.slots);
      expect(got!.prompt!.sub_prompts ?? null).toEqual(want.prompt!.sub_prompts ?? null);
    }
  });

  test("ensureJudgePromptOverrides applies DB prompts verbatim", async () => {
    __resetJudgeRegistryCacheForTest();
    clearJudgePromptOverrides();
    try {
      await ensureJudgePromptOverrides();
      for (const want of DEFAULT_JUDGE_ROWS) {
        if (want.kind !== "llm") continue;
        // sentinel default: if the override were missing we'd get "MISSING" back
        expect(promptBody(want.name, "MISSING")).toBe(want.prompt!.body);
        expect(promptOutput(want.name, "MISSING")).toBe(want.prompt!.output);
      }
      expect(promptSub("variable_extraction", "review_config_default", "MISSING")).not.toBe("MISSING");
    } finally {
      clearJudgePromptOverrides();
      __resetJudgeRegistryCacheForTest();
    }
  });
});
