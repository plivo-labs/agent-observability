// LLM-assisted authoring for custom metrics: generate candidates from a flow,
// improve a draft description, and calibrate a description from a flagged
// example. All three reuse the service's single LLM chokepoint (completeJSON)
// and the judge model, and none persist anything — they are pure transforms
// that hand text back to the console for the user to review and save.
//
// These live in AO (not a separate eval service) because AO owns the judge
// contract the output must satisfy and already holds the call transcripts the
// calibration step needs. They are account-blind and generic: any OSS install
// with an LLM configured gets them.
import { z } from "zod";
import { sql } from "../db.js";
import { completeJSON } from "../llm/index.js";
import type { LlmProvider } from "../llm/index.js";

const SCOPE = z.enum(["conversation", "node"]);
type Scope = z.infer<typeof SCOPE>;

// The shared contract every generated/rewritten description must honour — the
// same rules the runtime judge applies, so what the LLM writes here is what the
// judge can actually evaluate later.
const RUBRIC_RULES = `A good metric description is a single, unambiguous pass/fail rule a judge can decide from the call transcript alone:
- State plainly what makes the call PASS and what makes it FAIL.
- Judge only on transcript evidence; never assume unstated facts.
- "unknown" is the honest verdict when the call never reached the situation the metric describes.
- Be specific to observable behaviour (what was said, which tool ran, what was confirmed), not internal variable names.
- Keep it to 1-3 sentences of plain language — no "ALL of"/"ANY of" logic scaffolding.`;

const scopeHint = (scope: Scope): string =>
  scope === "node"
    ? "This metric is scored per NODE (the agent's turns inside one flow node), so phrase it about a single node's behaviour."
    : "This metric is scored per CALL (the whole conversation), so phrase it about the overall call outcome.";

// ── improve ──────────────────────────────────────────────────────────────────
const ImproveZ = z.object({ display_name: z.string(), description: z.string() });
const IMPROVE_JSON = {
  name: "improved_metric",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["display_name", "description"],
    properties: { display_name: { type: "string" }, description: { type: "string" } },
  },
} as const;

export async function improveMetricDescription(
  input: { name?: string; description: string; scope: Scope },
  provider?: LlmProvider,
): Promise<z.infer<typeof ImproveZ>> {
  const system = `You rewrite a rough custom-metric idea into a crisp evaluation rubric.
${RUBRIC_RULES}
${scopeHint(input.scope)}
Preserve the author's INTENT exactly — sharpen wording, do not invent new criteria. Return a concise display_name (<= 60 chars) and the improved description.`;
  const prompt = `Metric name: ${input.name || "(none)"}\nDraft description:\n${input.description}`;
  const { data } = await completeJSON({
    schema: ImproveZ,
    jsonSchema: IMPROVE_JSON,
    system,
    prompt,
    role: "judge",
    label: "metric_improve",
    maxTokens: 800,
    provider,
  });
  return data;
}

// ── generate ─────────────────────────────────────────────────────────────────
const GeneratedMetricZ = z.object({
  display_name: z.string(),
  description: z.string(),
  scope: SCOPE,
});
const GenerateZ = z.object({ metrics: z.array(GeneratedMetricZ) });
const GENERATE_JSON = {
  name: "generated_metrics",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["metrics"],
    properties: {
      metrics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["display_name", "description", "scope"],
          properties: {
            display_name: { type: "string" },
            description: { type: "string" },
            scope: { type: "string", enum: ["conversation", "node"] },
          },
        },
      },
    },
  },
} as const;

interface FlowNode {
  name?: string;
  type?: string;
  instructions?: string;
  intents?: string[];
  variables?: string[];
}
export interface FlowSummaryInput {
  name?: string;
  nodes?: FlowNode[];
  edges?: Array<{ source?: string; target?: string; label?: string }>;
}

/** Compact, LLM-readable summary of a flow. Mirrors the shape the goal
 *  generator built, but from the trimmed node list the console sends. */
export function summarizeFlow(flow: FlowSummaryInput): string {
  const lines: string[] = [`# Flow: ${flow.name || "Untitled"}`];
  const nodes = flow.nodes ?? [];
  lines.push(`Nodes: ${nodes.length}`, "");
  for (const n of nodes) {
    lines.push(`## [${n.type || "node"}] ${n.name || "Unnamed"}`);
    if (n.instructions) lines.push(`Instructions: ${n.instructions}`);
    if (n.intents?.length) lines.push(`Intents: ${n.intents.join(", ")}`);
    if (n.variables?.length) lines.push(`Variables: ${n.variables.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Bounded JSON so a large flow can't blow the prompt budget. */
function boundedJson(value: unknown, cap = 15000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length > cap ? `${text.slice(0, cap)}\n…(truncated)` : text;
}

export async function generateMetrics(
  input: {
    flow: FlowSummaryInput & Record<string, unknown>;
    existing?: Array<{ name?: string; description?: string }>;
    maxNew?: number;
  },
  provider?: LlmProvider,
): Promise<z.infer<typeof GenerateZ>> {
  const maxNew = Math.min(Math.max(input.maxNew ?? 5, 1), 10);
  const existing = (input.existing ?? [])
    .map((m) => `- ${m.name || ""}: ${m.description || ""}`)
    .join("\n");
  const system = `You are a QA lead defining the quality checks that matter for an AI voice/chat agent.
Propose up to ${maxNew} custom metrics that capture what "good" looks like on THIS flow — the guardrails and success criteria a reviewer would want flagged.
${RUBRIC_RULES}
Prefer per-call (conversation) scope; use per-node scope only when the check is about one specific node's behaviour.
Do NOT restate the default checks (hallucination, adherence, sentiment, etc.) — those already run on every call. Do NOT duplicate any existing metric below.
Return 0 to ${maxNew} metrics; return none if the flow is already well covered.${
    existing ? `\n\nExisting metrics (do not duplicate):\n${existing}` : ""
  }`;
  // A readable summary as a lead-in, then the full flow JSON so the model has
  // the complete configuration — AO forwards it verbatim and makes no
  // assumptions about the flow's shape.
  const prompt = `${summarizeFlow(input.flow)}\n\nFull flow configuration (JSON):\n${boundedJson(input.flow)}`;
  const { data } = await completeJSON({
    schema: GenerateZ,
    jsonSchema: GENERATE_JSON,
    system,
    prompt,
    role: "judge",
    label: "metric_generate",
    maxTokens: 2000,
    provider,
  });
  const seen = new Set(
    (input.existing ?? []).map((m) => (m.name || "").trim().toLowerCase()),
  );
  const metrics = data.metrics
    .filter((m) => !seen.has(m.display_name.trim().toLowerCase()))
    .slice(0, maxNew);
  return { metrics };
}

// ── calibrate ────────────────────────────────────────────────────────────────
const CalibrateZ = z.object({ description: z.string() });
const CALIBRATE_JSON = {
  name: "calibrated_metric",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["description"],
    properties: { description: { type: "string" } },
  },
} as const;

export class NoCalibrationTranscriptsError extends Error {}

interface CalibrationExampleInput {
  session_id: string;
  desired_verdict: "pass" | "fail";
  reason?: string;
}

/** Flatten a stored chat_history blob into a plain "Role: text" transcript,
 *  including tool calls/results, bounded so a long call can't blow the prompt. */
function renderTranscript(chatHistory: unknown, cap = 8000): string {
  const items = Array.isArray(chatHistory)
    ? chatHistory
    : ((chatHistory as { items?: unknown[] })?.items ?? []);
  const out: string[] = [];
  for (const it of items as Array<Record<string, unknown>>) {
    const type = it?.type;
    if (type === "function_call") {
      out.push(`Tool_Call: ${String(it.name ?? "")}(${String(it.arguments ?? "")})`);
    } else if (type === "function_call_output") {
      out.push(`Tool_Result: ${String(it.output ?? "")}`);
    } else {
      const role = String(it.role ?? "message");
      const content = Array.isArray(it.content)
        ? it.content.map((c) => (typeof c === "string" ? c : String((c as { text?: string })?.text ?? ""))).join(" ")
        : String(it.content ?? "");
      if (content.trim()) out.push(`${role}: ${content}`);
    }
  }
  const text = out.join("\n");
  return text.length > cap ? `${text.slice(0, cap)}\n…(truncated)` : text;
}

export async function calibrateMetric(
  input: {
    name?: string;
    description: string;
    scope: Scope;
    examples: CalibrationExampleInput[];
  },
  provider?: LlmProvider,
): Promise<z.infer<typeof CalibrateZ>> {
  const ids = input.examples.map((e) => e.session_id);
  const idsLiteral = `{${ids.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",")}}`;
  const rows = (await sql`
    SELECT session_id, chat_history FROM ao_agent_transport_sessions
    WHERE session_id = ANY(${idsLiteral}::text[])
  `) as Array<{ session_id: string; chat_history: unknown }>;
  const byId = new Map(rows.map((r) => [r.session_id, r.chat_history]));

  const blocks = input.examples
    .map((ex, i) => {
      const t = renderTranscript(byId.get(ex.session_id));
      if (!t.trim()) return "";
      return `### Example ${i + 1} — the CORRECT verdict is ${ex.desired_verdict.toUpperCase()}${
        ex.reason ? ` (reviewer note: ${ex.reason})` : ""
      }\nTranscript:\n${t}`;
    })
    .filter(Boolean);
  if (blocks.length === 0) throw new NoCalibrationTranscriptsError("no transcripts found for the flagged calls");

  const system = `You refine a custom-metric description using reviewer-labeled examples.
The current description made a WRONG call on the examples below: for each, the reviewer states the verdict that is actually correct.
Rewrite the description so a judge applying it to these transcripts would reach the stated verdict — while keeping the metric's original intent and staying general (do not hard-code these specific calls).
${RUBRIC_RULES}
${scopeHint(input.scope)}
Return only the improved description.`;
  const prompt = `Metric name: ${input.name || "(none)"}\nCurrent description:\n${input.description}\n\n${blocks.join("\n\n")}`;
  const { data } = await completeJSON({
    schema: CalibrateZ,
    jsonSchema: CALIBRATE_JSON,
    system,
    prompt,
    role: "judge",
    label: "metric_calibrate",
    maxTokens: 1000,
    provider,
  });
  return data;
}
