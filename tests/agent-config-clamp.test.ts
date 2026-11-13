import { describe, test, expect } from "bun:test";
import { boundInstructions, clampAgentConfig, MAX_INSTRUCTIONS_CHARS } from "../src/livekit/agent-config-clamp.js";

const globalPrompt = "Global rules. ".repeat(10_000);
const task = "# Current Task Instructions\nAnswer billing questions.\n## Session context\n{\"plan\": \"enterprise\"}\n";

describe("oversized node instructions", () => {
  test("instructions under the cap are kept as sent", () => {
    const short = `Persona.\n${task}`;
    expect(boundInstructions(short, globalPrompt)).toBe(short);
  });

  test("a rendered prompt keeps its task once the global prompt copy is dropped", () => {
    const rendered = `Persona.\n${globalPrompt}\n${task}`;
    const bounded = boundInstructions(rendered, globalPrompt);
    expect(bounded.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(bounded).not.toContain(globalPrompt);
    expect(bounded.endsWith(task)).toBe(true);
  });

  test("when still too long, the head and tail survive and the middle goes", () => {
    const head = "Persona rules first.\n";
    const rendered = head + "x".repeat(MAX_INSTRUCTIONS_CHARS * 2) + task;
    const bounded = boundInstructions(rendered, "");
    expect(bounded.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(bounded.startsWith(head)).toBe(true);
    expect(bounded.endsWith(task)).toBe(true);
    expect(bounded).toContain("omitted");
  });

  test("clampAgentConfig bounds each node against the config's global prompt", () => {
    const config = { global_prompt: globalPrompt, nodes: [{ ref: "n1", instructions: `Persona.\n${globalPrompt}\n${task}` }] };
    const [node] = clampAgentConfig(config).nodes as Array<{ instructions: string }>;
    expect(node!.instructions.endsWith(task)).toBe(true);
  });
});
