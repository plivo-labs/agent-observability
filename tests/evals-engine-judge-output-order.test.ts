import { describe, test, expect, mock } from "bun:test";
import { TEST_JUDGE_CONFIG_MODULE } from "./fixtures/judge-config.js";

mock.module("../src/config.js", () => TEST_JUDGE_CONFIG_MODULE);

const schemas = await import("../src/evals-engine/judges/schemas.js");
const instructions = await import("../src/evals-engine/judges/instructions.js");
const conv = await import("../src/evals-engine/judges/conversation-judges.js");

type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: string[]; items?: Schema };

const keysOf = (s: Schema): string[] => Object.keys(s.properties ?? {});

function objects(s: Schema): Schema[] {
  if (s.type === "array" && s.items) return objects(s.items);
  if (s.type !== "object") return [];
  return [s, ...Object.values(s.properties ?? {}).flatMap(objects)];
}

/** Pre-order, because the OUT text lists nested fields inline. */
function fieldOrder(s: Schema): string[] {
  if (s.type === "array" && s.items) return fieldOrder(s.items);
  if (s.type !== "object") return [];
  return Object.entries(s.properties ?? {}).flatMap(([k, v]) => [k, ...fieldOrder(v)]);
}

const listedFields = (out: string): string[] => [...out.matchAll(/"(\w+)":/g)].map((m) => m[1]!);

const JUDGES: Array<{ name: string; schema: Schema; out: string; verdict: string[] }> = [
  { name: "hallucination", schema: schemas.HALLUCINATION_JSON.schema, out: instructions.OUT_HALLUCINATION, verdict: ["hallucinated", "score"] },
  { name: "node_loop", schema: schemas.NODE_LOOP_JSON.schema, out: instructions.OUT_LOOP, verdict: ["loop_detected", "score"] },
  { name: "variable_extraction", schema: schemas.VARIABLE_EXTRACTION_JSON.schema, out: instructions.OUT_VARIABLE, verdict: ["extraction_successful", "score"] },
  { name: "intent_identification", schema: schemas.INTENT_JSON.schema, out: instructions.OUT_INTENT, verdict: ["intent_not_found", "intent_wrongly_identified"] },
  { name: "detection", schema: schemas.DETECTION_JSON.schema, out: conv.OUT_DETECTION, verdict: ["detected"] },
  { name: "user_sentiment", schema: schemas.SENTIMENT_JSON.schema, out: conv.OUT_SENTIMENT, verdict: ["sentiment"] },
  { name: "stt", schema: schemas.STT_JSON.schema, out: conv.OUT_STT, verdict: ["error_count", "recovered_count"] },
];

const ADHERENCE = schemas.INSTRUCTION_ADHERENCE_JSON.schema as Schema;

describe("judge schemas put reasoning before the verdict", () => {
  for (const j of JUDGES) {
    test(`${j.name}: verdict keys come last, after technical_reason and reason`, () => {
      const keys = keysOf(j.schema);
      expect(keys.slice(-j.verdict.length)).toEqual(j.verdict);
      expect(keys.slice(0, -j.verdict.length)).toEqual(expect.arrayContaining(["technical_reason", "reason"]));
    });
  }

  test("instructions_adherence: each sub-dimension writes its reasons before its code, boolean and score", () => {
    const sub = (name: string) => ADHERENCE.properties![name]!;
    const expected: Record<string, string[]> = {
      objective_progress: ["reason_code", "achieved", "score"],
      procedure_compliance: ["reason_code", "score"],
      interaction_quality: ["reason_code", "score"],
      policy_boundary_compliance: ["reason_code", "passed", "score"],
    };
    for (const [name, verdict] of Object.entries(expected)) {
      const keys = keysOf(sub(name));
      expect(keys.slice(-verdict.length)).toEqual(verdict);
      expect(keys.slice(0, -verdict.length)).toEqual(expect.arrayContaining(["technical_reason", "reason"]));
    }
    const missedStep = sub("procedure_compliance").properties!.missed_steps!.items!;
    expect(keysOf(missedStep).at(-1)).toBe("severity");
  });

  test("instructions_adherence: config_conflicts is filled before any sub-dimension is decided", () => {
    expect(keysOf(ADHERENCE)[0]).toBe("config_conflicts");
  });

  test("every object schema requires exactly its properties, in properties order", () => {
    for (const root of [...JUDGES.map((j) => j.schema), ADHERENCE]) {
      for (const o of objects(root)) expect(o.required).toEqual(keysOf(o));
    }
  });
});

describe("output sections list fields in schema order", () => {
  for (const j of [...JUDGES, { name: "instructions_adherence", schema: ADHERENCE, out: instructions.OUT_INSTRUCTION }]) {
    test(j.name, () => {
      expect(listedFields(j.out)).toEqual(fieldOrder(j.schema));
    });
  }
});
