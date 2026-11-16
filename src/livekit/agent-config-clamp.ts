// Caps on the judging surface one config can demand: each judged node costs
// ~5 LLM calls, so an unbounded config would let a single ingested session
// trigger an unbounded provider bill. Oversized configs are clamped (never
// rejected) and the truncation is logged.
const MAX_CONFIG_NODES = 150;
// Intents / variables per node.
const MAX_NODE_LIST_ITEMS = 100;
// The judges read a node's instructions together with global_prompt, so the two
// share one budget; a node always keeps at least the per-node floor.
export const MAX_INSTRUCTIONS_CHARS = 50_000;
export const MAX_PROMPT_CHARS = 200_000;

// A sender may ship a node's fully rendered prompt, which repeats global_prompt
// (stored separately) and carries the node's task and runtime context anywhere in it.
const GLOBAL_PROMPT_MARKER = "\n[global_prompt: sent separately]\n";
const MIN_DEDUP_CHARS = 1_000;

export function instructionsBudget(globalPrompt: unknown): number {
  const globalChars = typeof globalPrompt === "string" ? globalPrompt.length : 0;
  return Math.max(MAX_INSTRUCTIONS_CHARS, MAX_PROMPT_CHARS - globalChars);
}

/** Fit oversized instructions in the budget: drop a verbatim copy of the global
 *  prompt first, then keep the head and the tail. A cut is a last resort: it can
 *  still lose context that sits in the middle. */
export function boundInstructions(instructions: string, globalPrompt: unknown): string {
  const budget = instructionsBudget(globalPrompt);
  if (instructions.length <= budget) return instructions;
  let text = instructions;
  if (typeof globalPrompt === "string" && globalPrompt.trim().length >= MIN_DEDUP_CHARS && text.includes(globalPrompt)) {
    text = text.replace(globalPrompt, GLOBAL_PROMPT_MARKER);
  }
  if (text.length <= budget) return text;
  const marker = "\n…[middle of the instructions omitted]…\n";
  const keep = budget - marker.length;
  const head = Math.floor(keep / 2);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

export function clampAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  let clamped = false;
  const boundedNodes = nodes.slice(0, MAX_CONFIG_NODES).map((n) => {
    if (typeof n !== "object" || n === null) return n;
    const node = { ...(n as Record<string, unknown>) };
    if (typeof node.instructions === "string" && node.instructions.length > instructionsBudget(config.global_prompt)) {
      node.instructions = boundInstructions(node.instructions, config.global_prompt);
      clamped = true;
    }
    for (const key of ["intents", "variables"]) {
      if (Array.isArray(node[key]) && (node[key] as unknown[]).length > MAX_NODE_LIST_ITEMS) {
        node[key] = (node[key] as unknown[]).slice(0, MAX_NODE_LIST_ITEMS);
        clamped = true;
      }
    }
    return node;
  });
  if (nodes.length > MAX_CONFIG_NODES) clamped = true;
  if (clamped) {
    console.warn(`[otlp] agent config clamped to ${MAX_CONFIG_NODES} nodes / ${MAX_NODE_LIST_ITEMS} intents+variables per node / ${MAX_PROMPT_CHARS} instruction+global_prompt chars`);
  }
  return { ...config, nodes: boundedNodes };
}
