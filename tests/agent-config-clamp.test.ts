import { describe, test, expect } from "bun:test";
import {
  boundInstructions, clampAgentConfig, instructionsBudget, MAX_INSTRUCTIONS_CHARS, MAX_PROMPT_CHARS,
} from "../src/livekit/agent-config-clamp.js";

const globalPrompt = "Global rules. ".repeat(10_000);
const task = "# Current Task Instructions\nAnswer billing questions.\n## Session context\n{\"plan\": \"enterprise\"}\n";

describe("oversized node instructions", () => {
  test("instructions within the budget are kept as sent", () => {
    const short = `Persona.\n${task}`;
    expect(boundInstructions(short, globalPrompt)).toBe(short);
  });

  test("a rendered prompt keeps its task once the global prompt copy is dropped", () => {
    const rendered = `Persona.\n${globalPrompt}\n${task}`;
    const bounded = boundInstructions(rendered, globalPrompt);
    expect(bounded.length).toBeLessThanOrEqual(instructionsBudget(globalPrompt));
    expect(bounded).not.toContain(globalPrompt);
    expect(bounded.endsWith(task)).toBe(true);
  });

  test("with no global prompt, a long node prompt is kept whole, context in the middle included", () => {
    const rendered = `Persona.\n${"Rule. ".repeat(25_000)}\n${task}\n${"More rules. ".repeat(3_000)}`;
    expect(rendered.length).toBeGreaterThan(MAX_INSTRUCTIONS_CHARS);
    expect(boundInstructions(rendered, "")).toBe(rendered);
  });

  test("past the shared budget, the head and tail survive and the middle goes", () => {
    const head = "Persona rules first.\n";
    const bounded = boundInstructions(head + "x".repeat(MAX_PROMPT_CHARS * 2) + task, "");
    expect(bounded.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(bounded.startsWith(head)).toBe(true);
    expect(bounded.endsWith(task)).toBe(true);
    expect(bounded).toContain("omitted");
  });

  test("a global prompt larger than the budget still leaves the node its floor", () => {
    expect(instructionsBudget("G".repeat(MAX_PROMPT_CHARS))).toBe(MAX_INSTRUCTIONS_CHARS);
    expect(boundInstructions("y".repeat(80_000), "G".repeat(MAX_PROMPT_CHARS)).length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
  });

  test("clampAgentConfig bounds each node against the config's global prompt", () => {
    const config = { global_prompt: globalPrompt, nodes: [{ ref: "n1", instructions: `Persona.\n${globalPrompt}\n${task}` }] };
    const [node] = clampAgentConfig(config).nodes as Array<{ instructions: string }>;
    expect(node!.instructions.endsWith(task)).toBe(true);
  });
});
