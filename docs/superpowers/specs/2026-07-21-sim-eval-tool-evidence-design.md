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

This change affects only simulation evaluator input. It does not change tool
execution, simulation mocks, durable transcript payloads, run pass/fail rules,
judge prompts, or live-session ingestion.

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
- Emit `Tool_Result: <name> -> <output>` only when the response contains a
  non-null output. Preserve string outputs and JSON-serialize other values.
- Treat calls and results as evidence, never as `Agent:` speech.
- Ignore malformed entries without throwing or dropping the surrounding turn.
- Do not fabricate a result for handoff calls whose output is `null`.

Both `full_transcript` and each node transcript use the shared renderer, so one
implementation supplies evidence to hallucination, adherence, intent,
variable, loop, and goal judges. Keeping tool calls on their original turn
preserves simulation turn counts and node grouping.

## LiveKit Contract

PlivoCX LiveKit's simulation runner already deduplicates calls, pairs function
outputs with calls, and attaches `output`, `is_error`, `tool_type`, `mocked`, and
`mock_source_key` metadata to each returned `tool_calls[]` entry. AO consumes
that response as evidence; it does not execute or reconstruct mocks.

When action mocks are configured, LiveKit returns the mocked output on the tool
call. When no output exists, as with the handoff calls in run `79fa6f82`, AO
renders the call only.

## Verification

Add simulation-path regression tests covering:

1. A handoff call with `{}` arguments and `null` output appears as a call only.
2. A tool call with arguments and a result appears in both node and full
   transcripts without an `Agent:` prefix.
3. JSON argument strings are not double encoded.
4. Malformed tool-call entries are ignored without throwing.
5. Node turn counts remain unchanged.

Run the focused eval-engine tests, typecheck, and the full test suite before
opening a PR targeting `dev`.

## Out of Scope

- Changing how LiveKit executes or mocks tools.
- Synthesizing outputs for calls that returned no output.
- Changing goal applicability, run counters, adherence calibration, or judge
  prompts.
