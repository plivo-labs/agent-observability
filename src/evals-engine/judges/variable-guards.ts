import type { NodeEvalInput } from "../types.js";

// Deterministic eligibility shared by candidate reduction and LLM verification.
const RECORDING_ACTION = String.raw`(?:submit|submission|record|extract|capture)`;
const TERMINAL_ACTION = String.raw`(?:transfer|handoff|ending|end)`;
const RECORDING_SCHEDULE_LINE = new RegExp(`${RECORDING_ACTION}.*${TERMINAL_ACTION}|${TERMINAL_ACTION}.*${RECORDING_ACTION}`, "i");
const RECORDING_BEFORE_TERMINAL = new RegExp(
  `${RECORDING_ACTION}[\\s\\S]{0,160}\\bbefore\\b[\\s\\S]{0,80}\\b${TERMINAL_ACTION}\\b|` +
    `\\bbefore\\b[\\s\\S]{0,80}\\b${TERMINAL_ACTION}\\b[\\s\\S]{0,160}${RECORDING_ACTION}`,
);
const BATCH_SCOPE_AFTER_ACTION = new RegExp(
  `${RECORDING_ACTION}[\\s\\S]{0,140}\\b(?:all|remaining|collected|captured|known)\\b[\\s\\S]{0,80}\\b(?:data|details|information|fields|variables)\\b`,
);
const BATCH_SCOPE_BEFORE_ACTION = new RegExp(
  `\\b(?:all|remaining|collected|captured|known)\\b[\\s\\S]{0,80}\\b(?:data|details|information|fields|variables)\\b[\\s\\S]{0,140}${RECORDING_ACTION}`,
);
const BATCH_PRONOUN_SCHEDULE = new RegExp(
  `\\brecord them\\b[\\s\\S]{0,80}\\b(?:before|prior to)\\b[\\s\\S]{0,80}\\b${TERMINAL_ACTION}\\b`,
);
const LEGACY_LEAD_BATCH_OBJECT = /\blead (?:data|details)\b/;
const INTERRUPTED_TERMINAL_TURN = /\b(?:transfer|handoff|ending|end)\b/i;
const EARLY_RECORDING_RULE = /immediately|at once|as soon as|after each|record (?:it|this|the value) (?:when|after)/;

const WORKFLOW_RULE_EVIDENCE =
  /agent-authored|workflow (?:field|status|disposition|label)|mapped (?:workflow )?(?:status|disposition|outcome)|internal score|concise summary|normalized overall (?:interest )?status|final (?:workflow )?(?:status|disposition|outcome|classification)|final outcome (?:was )?reached/;
const PLATFORM_RULE_EVIDENCE =
  /backend|platform|initial context|tool (?:result|output)|lookup (?:result|output)|runtime|internal (?:id|identifier)|returned by (?:the |a )?[^.]{0,40}(?:action|tool|lookup)/;

export interface FinalBatchContext {
  cutoffConfirmed: boolean;
  recordingSchedule: string;
  schedulesCompleteBatch: boolean;
}

function recordingScheduleExcerpt(node: NodeEvalInput): string {
  return node.node_prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => RECORDING_SCHEDULE_LINE.test(line))
    .slice(0, 5)
    .join("\n")
    .slice(0, 2000);
}

export function finalBatchContext(node: NodeEvalInput): FinalBatchContext {
  const recordingSchedule = recordingScheduleExcerpt(node);
  const chronological = node.turns.filter((turn) => !turn.idle && (turn.user || turn.agent));
  const last = chronological.at(-1);
  const previous = chronological.at(-2);
  const hasInterruptedTerminalTail = !!(
    last?.user &&
    !last.agent &&
    !last.evidence &&
    previous?.agent.toLowerCase().includes("[interrupted]") &&
    INTERRUPTED_TERMINAL_TURN.test(previous.agent) &&
    !previous.evidence
  );
  const prompt = node.node_prompt.toLowerCase();
  const cutoffConfirmed = hasInterruptedTerminalTail && RECORDING_BEFORE_TERMINAL.test(prompt);
  const schedule = recordingSchedule.toLowerCase();
  const schedulesCompleteBatch =
    cutoffConfirmed &&
    (BATCH_SCOPE_AFTER_ACTION.test(schedule) ||
      BATCH_SCOPE_BEFORE_ACTION.test(schedule) ||
      BATCH_PRONOUN_SCHEDULE.test(schedule) ||
      LEGACY_LEAD_BATCH_OBJECT.test(schedule));

  return { cutoffConfirmed, recordingSchedule, schedulesCompleteBatch };
}

export function finalBatchCoversVariable(
  batch: FinalBatchContext,
  node: NodeEvalInput,
  variableName: string,
): boolean {
  if (!batch.schedulesCompleteBatch) return false;
  const rule = node.variable_rules?.[variableName]?.toLowerCase() ?? "";
  return !EARLY_RECORDING_RULE.test(rule);
}

export function outOfScopeVariableKind(
  _variableName: string,
  rule: string | undefined,
): "platform" | "workflow" | undefined {
  const normalizedRule = rule?.toLowerCase() ?? "";
  if (PLATFORM_RULE_EVIDENCE.test(normalizedRule)) return "platform";

  // Only the rule can establish a workflow-produced field. A workflow-shaped
  // name alone cannot suppress caller fields such as visa_status.
  if (WORKFLOW_RULE_EVIDENCE.test(normalizedRule)) return "workflow";
  return undefined;
}
