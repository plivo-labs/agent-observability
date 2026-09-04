// Prompt override store for the judge registry. Deliberately import-free: the
// judge modules read it at call time, the registry loader (which imports the
// db) writes it — keeping every judge module mockable without touching db.js.
//
// An override carries the same body/output split the code constants use;
// composition (separators, fill() slots, the fence/language suffixes) stays in
// code, so a row byte-identical to the shipped constants produces a
// byte-identical system prompt — the parity gate proves exactly that.

export type JudgePromptOverride = {
  body: string;
  output: string;
  sub_prompts?: Record<string, string>;
};

let overrides: ReadonlyMap<string, JudgePromptOverride> = new Map();

export function setJudgePromptOverrides(next: ReadonlyMap<string, JudgePromptOverride>): void {
  overrides = next;
}

export function clearJudgePromptOverrides(): void {
  overrides = new Map();
}

export const promptBody = (judge: string, shipped: string): string =>
  overrides.get(judge)?.body ?? shipped;

export const promptOutput = (judge: string, shipped: string): string =>
  overrides.get(judge)?.output ?? shipped;

export const promptSub = (judge: string, key: string, shipped: string): string =>
  overrides.get(judge)?.sub_prompts?.[key] ?? shipped;
