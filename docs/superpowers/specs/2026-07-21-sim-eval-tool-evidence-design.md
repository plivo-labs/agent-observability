# Simulation Eval Tool Evidence Design

## Problem

The simulation `/turn` response contains `tool_calls`, including function-call
arguments and an attached output/error/mock result when LiveKit has one. AO
copies that array into the durable `turn_completed` transcript, but creates a
separate evaluator turn containing only `node_uuid`, user speech, agent speech,
and intent. Node and goal judges therefore cannot see actions that occurred.

The live-session evaluator already treats function calls and outputs as
grounding evidence. The simulation evaluator must provide the same evidence.

## Scope

This change affects simulation evaluator input only. It does not change judge
instructions, tool execution, simulation mocks, durable transcript payloads,
run pass/fail rules, live-session ingestion, or real-session judging behavior.

## Design

Extend `EvalTurn` with an optional `tool_calls` array and copy the raw
`LiveKitSimResponse.tool_calls` array onto every simulation evaluator turn.
The shared transcript renderer will convert each valid entry into bare runtime
evidence lines between the user and agent lines:

```text
User: Can you call tomorrow?
Tool_Call: handoff_busy_callback({})
Tool_Result: lookup_availability -> {"available":true}
Agent: I will arrange that callback.
```

Rendering rules:

- Emit `Tool_Call: <name>(<arguments>)` for every entry with a non-empty name.
- Preserve JSON argument strings without double encoding. Serialize object or
  scalar arguments as JSON. Missing arguments render as an empty argument list.
- For a non-error call, emit `Tool_Result: <name> -> <output>` only when the
  response contains a non-null output. Preserve string outputs and
  JSON-serialize other values.
- When `is_error` is true, render the result as
  `Tool_Result: <name> -> ERROR: <output>`. If the error has no output, render
  `Tool_Result: <name> -> ERROR`. A failed result must remain distinguishable
  from a successful one.
- Treat calls and results as evidence, never as `Agent:` speech.
- Ignore malformed entries without throwing or dropping the surrounding turn.
- Do not fabricate a result for handoff calls whose output is `null`.

Both `full_transcript` and each node transcript use the shared renderer, so one
implementation supplies evidence to hallucination, adherence, intent,
variable, loop, and goal judges. Keeping tool calls on their original turn
preserves simulation turn counts and node grouping.

## Judge Behavior

This PR does not add or change any judge instruction. Simulation calls and
results use the same `Tool_Call` / `Tool_Result` evidence labels already used
for real sessions, and the existing shared judge rubric interprets both paths.
The PR must not introduce stricter call/result requirements for real sessions.

## LiveKit Contract

PlivoCX LiveKit's simulation runner already deduplicates calls, pairs function
outputs with calls, and attaches `output`, `is_error`, `tool_type`, `mocked`, and
`mock_source_key` metadata to each returned `tool_calls[]` entry. AO consumes
that response as evidence; it does not execute or reconstruct mocks.

When action mocks are configured, LiveKit returns the mocked output on the tool
call. When no output exists, as with the handoff calls in run `79fa6f82`, AO
renders the call only.

AO does not synthesize missing results. Scenario generation and LiveKit remain
responsible for supplying deterministic `action_mocks` for action, lookup, or
HTTP tools whose returned content is required by the scenario. A follow-up can
preflight `required_mocked_actions` and mark a scenario mock-incomplete instead
of allowing the judge to infer an unavailable result. That validation is not
part of this PR.

## Verification

Add simulation-path regression tests covering:

1. A handoff call with `{}` arguments and `null` output appears as a call only.
2. A tool call with arguments and a result appears in both node and full
   transcripts without an `Agent:` prefix.
3. JSON argument strings are not double encoded.
4. Malformed tool-call entries are ignored without throwing.
5. Node turn counts remain unchanged.
6. Successful mocked output renders as ordinary authoritative result evidence.
7. Failed tool output is visibly marked `ERROR` and cannot resemble success.
8. The six audited false-positive boundaries remain clean after tool evidence
   is added under the existing, unchanged judge prompt.

Run the focused eval-engine tests, typecheck, and the full test suite before
opening a PR targeting `dev`. Run the six privacy-safe live judge boundaries
with `bun run scripts/sim-tool-evidence-smoke.ts`; the script exits non-zero if
any false-positive boundary overfires.

## Out of Scope

- Changing how LiveKit executes or mocks tools.
- Synthesizing outputs for calls that returned no output.
- Changing goal applicability, run counters, adherence calibration, or any
  shared judge prompt.
- Enforcing `required_mocked_actions` coverage or failing mock-incomplete
  scenarios; that belongs to a LiveKit/scenario-generation follow-up.
