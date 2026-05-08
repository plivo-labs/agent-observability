import { escapeLikePattern } from "../response.js";

// Sentinel value used in URL filters to represent rows with NULL agent_id.
export const UNKNOWN_AGENT_ID = "__unknown__";

export interface ListEvalRunsOpts {
  limit: number;
  offset: number;
  accountId?: string | null;
  agentId?: string | null;
  agentIdExact?: string | null;
  frameworks?: string[] | null;
  testingFrameworks?: string[] | null;
  startedFrom?: string | null;
  startedTo?: string | null;
}

export function buildEvalRunPredicates(
  opts: ListEvalRunsOpts,
): { predicates: string[]; params: unknown[] } {
  const predicates: string[] = [];
  const params: unknown[] = [];
  if (opts.accountId) {
    predicates.push(`LOWER(eval_runs.account_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.accountId.toLowerCase())}%`);
  }

  const agentId = opts.agentIdExact ?? opts.agentId;
  if (agentId === UNKNOWN_AGENT_ID) {
    predicates.push("eval_runs.agent_id IS NULL");
  } else if (opts.agentIdExact) {
    predicates.push(`eval_runs.agent_id = $${params.length + 1}`);
    params.push(opts.agentIdExact);
  } else if (opts.agentId) {
    predicates.push(`LOWER(eval_runs.agent_id) LIKE $${params.length + 1}`);
    params.push(`%${escapeLikePattern(opts.agentId.toLowerCase())}%`);
  }

  if (opts.frameworks && opts.frameworks.length > 0) {
    const placeholders = opts.frameworks.map((_, i) => `$${params.length + i + 1}`);
    predicates.push(`eval_runs.framework IN (${placeholders.join(", ")})`);
    params.push(...opts.frameworks);
  }

  if (opts.testingFrameworks && opts.testingFrameworks.length > 0) {
    const placeholders = opts.testingFrameworks.map(
      (_, i) => `$${params.length + i + 1}`,
    );
    predicates.push(`eval_runs.testing_framework IN (${placeholders.join(", ")})`);
    params.push(...opts.testingFrameworks);
  }

  if (opts.startedFrom) {
    predicates.push(`eval_runs.started_at >= $${params.length + 1}`);
    params.push(opts.startedFrom);
  }
  if (opts.startedTo) {
    predicates.push(`eval_runs.started_at <= $${params.length + 1}`);
    params.push(opts.startedTo);
  }
  return { predicates, params };
}
