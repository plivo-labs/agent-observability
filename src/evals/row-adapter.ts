const RUN_BIGINT_FIELDS = [
  "duration_ms",
  "prompt_tokens",
  "cached_prompt_tokens",
  "completion_tokens",
  "total_tokens",
] as const;

const CASE_BIGINT_FIELDS = [
  "duration_ms",
  "prompt_tokens",
  "cached_prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "turn_count",
  "tool_call_count",
  "interruption_count",
  "agent_handoff_count",
  "ttft_sample_count",
] as const;

export function parseRunRow(row: any): any {
  for (const f of RUN_BIGINT_FIELDS) {
    if (row[f] != null) row[f] = Number(row[f]);
  }
  return row;
}

export function parseCaseRow(row: any): any {
  for (const f of CASE_BIGINT_FIELDS) {
    if (row[f] != null) row[f] = Number(row[f]);
  }
  return row;
}

export function decodeCaseJsonb(row: any): any {
  return {
    ...row,
    events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
    judgments: typeof row.judgments === "string" ? JSON.parse(row.judgments) : row.judgments,
    failure: typeof row.failure === "string" ? JSON.parse(row.failure) : row.failure,
  };
}
