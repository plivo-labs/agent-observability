// AO Eval Engine — HTTP surface for the cx-sqs-worker "Option A" redirect.
//
// POST /observability/evals/judge-conversation/v0
//   body:  cx-sqs-worker `ConversationInput`  ({ flow_definition, flow_run })
//   200 :  cx `ConversationEvaluationOutput`   ({ conversation, evaluation })
//
// The worker POSTs a completed real call here (when EVAL_ENGINE=ao) and persists the
// returned `evaluation` verbatim, so the response is byte-compatible with what its Go
// evaluator produces. Auth: the route is mounted with the same dual-auth (Basic OR
// LiveKit Bearer) as the other native ingest channels (see index.ts), so it is protected
// under either configured auth mode. Body size is capped like the other ingest channels,
// and node_run_history length is bounded below so an oversized body can't trigger
// unbounded judge fan-out. A judge/LLM failure returns 5xx so the worker requeues via SQS
// (the same contract as the Go evaluator returning an error).

import type { Hono } from "hono";
import { z } from "zod";
import { buildErrorResponse, formatZodError, sanitizeForLog } from "../response.js";
import { evaluateCxRedirect, type CxConversationInput } from "./integration/cx-redirect.js";

// Structural gate only — the adapter reads every field defensively, so we validate just
// enough to reject a payload that isn't a cx ConversationInput (missing envelope).
const judgeInputSchema = z
  .object({
    flow_definition: z.object({}).passthrough(),
    flow_run: z.object({}).passthrough(),
  })
  .passthrough();

// A completed real call has at most a few dozen executed nodes; each node runs several
// parallel LLM judges. Bound the history length so a malicious/oversized (but still
// under-16MB) body can't fan out into thousands of concurrent LLM calls. Well above any
// real call, far below abuse.
const MAX_NODE_HISTORY = 100;

export function registerJudgeConversationRoute(app: Hono) {
  app.post("/observability/evals/judge-conversation/v0", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e) {
      console.error(`[judge-conversation] invalid_json: ${(e as Error).message}`);
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }

    const parsed = judgeInputSchema.safeParse(body);
    if (!parsed.success) {
      console.error("[judge-conversation] invalid_payload: expected { flow_definition, flow_run }");
      return c.json(buildErrorResponse("invalid_payload", formatZodError(parsed.error)), 400);
    }

    const cx = parsed.data as CxConversationInput;

    // Bound judge fan-out: reject a payload with an implausibly long node history.
    const history = cx.flow_run?.node_run_history;
    if (Array.isArray(history) && history.length > MAX_NODE_HISTORY) {
      console.error(`[judge-conversation] too_many_nodes: ${history.length} > ${MAX_NODE_HISTORY}`);
      return c.json(
        buildErrorResponse("too_many_nodes", `node_run_history exceeds the ${MAX_NODE_HISTORY}-node limit`),
        400,
      );
    }

    const runUuid = cx.flow_run?.run_uuid ?? "-";
    const started = performance.now();

    try {
      const out = await evaluateCxRedirect(cx);
      const ms = Math.round(performance.now() - started);
      const nodes = out.evaluation.node_evaluations.length;
      const goals = out.evaluation.goal_evaluation?.goals?.length ?? 0;
      console.log(
        `[judge-conversation] run=${sanitizeForLog(runUuid)} nodes=${nodes} goals=${goals} in ${ms}ms`,
      );
      return c.json(out, 200);
    } catch (e) {
      // Node/goal judge failure (throws after its own retries). Return 5xx so the
      // worker requeues — a transient LLM error should retry, not persist an empty eval.
      // Log the detail server-side; return a generic message so provider/internal error
      // text isn't forwarded to the caller.
      console.error(`[judge-conversation] eval_failed run=${sanitizeForLog(runUuid)}: ${(e as Error).message}`);
      return c.json(buildErrorResponse("eval_failed", "judge evaluation failed"), 502);
    }
  });
}
