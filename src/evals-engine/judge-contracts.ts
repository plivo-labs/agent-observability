/** Backend-independent metric boundaries. Keep these in both judge prompts so
 * candidate probabilities and final verdicts refer to the same defect. */
export const SYSTEM_INTENTS = ["hangup", "error", "failed", "sent", "conversation_complete"] as const;

export const INTENT_CONTRACT =
  "Intent identification measures catalog coverage and selection correctness, not tool execution. " +
  `System intents (${SYSTEM_INTENTS.join(", ")}) never fail. ` +
  "A missing chosen_intent or absent handoff tool alone is not a defect. " +
  "With no recorded selection, not_found requires a clear caller need absent from the entire available intent list; " +
  "wrongly_identified requires positive evidence of a contradictory intent selection. With no user input and no selection evidence, neither fails. " +
  "A selected non-system intent outside the list is not_found, not wrongly_identified. " +
  "A selected listed intent is wrongly_identified only when its required conversational prerequisite was not delivered or the caller's request contradicts it. " +
  "Use semantic matches and treat ambiguous supported selections leniently. The two defects are mutually exclusive.";

export const ADHERENCE_CONTRACT =
  "Adherence fails only for an agent-caused failure to pursue this node's objective, a critical procedure omission, or an explicit policy boundary the agent crossed. " +
  "A missed step is critical only when its outcome was not achieved and it protects identity, consent, required disclosure, safety, or the correct channel. " +
  "Functional completion, paraphrase, reordered steps, minor omissions, style, tone, and interaction quality alone do not fail. " +
  "Intent selection, routing, transitions, hangup, variable capture, and fabricated facts belong to other metrics. " +
  "Recorder tools are silent bookkeeping; their serialized order is not a procedure violation. A separately required spoken confirmation remains a real step. " +
  "Judge only this node's spoken actions. Other nodes continuing is not evidence this node skipped a step. " +
  "Unreached steps after caller refusal, interruption, or call end are not omissions.";

export const VARIABLE_CONTRACT =
  "Evaluate configured caller-capture fields at the target node's exit, not against later corrections in another node. " +
  "Only names in the expected/declared variable list are graded; an additional runtime field alone is not a defect. " +
  "Apply each field's exact rule and active path. Missing caller information requires a value the caller explicitly supplied during this node, not a derived value or absent workflow/backend default. " +
  "A prior recorded value can satisfy a field. The latest non-failed write visible at node exit is supplied; variable_sources marks unconfirmed attempts, which are not proof of persistence. " +
  "Enforce an explicit confirmation eligibility rule when required confirmation never occurred, but do not fail merely because a recorder call precedes the spoken confirmation in serialized events. " +
  "An unreached question or interrupted final recording batch is not a missing value. A wrong recorded value still fails.";
