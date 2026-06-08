# Run a simulation or live call

QA an agent **before** launch. Point AO at an agent prompt (or a phone number),
let it run a sweep of personas against it, and get scored results with the
worst-moment and suggested fixes — all in the **Simulate** and **Live** tabs.

Two execution models, deliberately distinct:

| | **Simulate** | **Live** |
|---|---|---|
| What | Text persona conversations against a prompt | Real phone calls, one per persona |
| Speed / cost | Fast, cheap | Real telephony — slower, costs money |
| Needs | An LLM key (for real output) | The calling subsystem + telephony creds |
| Lands as | `eval_run` (`testing_framework=simulation`) | `eval_run` (`testing_framework=live-call`) |

Both are scored by the **same LLM judge** and both show up in **Evals**.

---

## Simulate (text) — the fast path

1. Open **Simulate**.
2. Paste your agent's **system prompt** (or upload a `sim.yaml`, or load a saved
   scenario from the Library).
3. Pick or auto-generate **personas** and a **rubric**.
4. **Run.** Personas run in parallel; you get a live view, then a report card
   with pass/fail, per-criterion verdicts, worst moments, and fixes.

### Make it real (not demo)

Generation is real only when an LLM is configured on the AO server. Set **one**
of these in AO's `.env`:

```bash
# OpenAI-compatible
SIM_LLM_API_KEY=...
SIM_LLM_BASE_URL=https://api.openai.com/v1
SIM_LLM_MODEL=gpt-4o-mini

# …or Azure OpenAI
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_API_VERSION=2024-12-01-preview
AZURE_OPENAI_DEPLOYMENT=gpt-4.1-mini
```

With neither set, Simulate returns **clearly-labelled, prompt-derived demo data**
so the UI is usable without keys — but it isn't a real diagnostic.

> **Generation vs judging are separate.** The LLM above produces the
> conversation. Per-criterion judging runs through AO's LiveKit-native judge;
> with a criteria rubric selected it uses the judge service, otherwise a
> heuristic. Set an LLM key for meaningful verdicts.

## Live (real calls)

Picking **voice** in Simulate (a phone number is required) hands off to **Live**,
which places one real call per persona, streams the transcript + audio, supports
**takeover** (a human grabs the mic mid-call), and scores each call against the
rubric (`overall = every criterion passes`).

Real calling needs more than an LLM key:

1. **Configure the caller** in AO's `.env`:
   ```bash
   TRUMAN_API_URL=http://localhost:9082
   TRUMAN_API_TOKEN=...
   ```
   Without these, Live runs a demo/LLM shell instead of dialing.

2. **Run the calling subsystem** (vendored at `services/calling/` — no external
   dependency). From the repo:
   ```bash
   bun run caller:infra     # Postgres + Redis (docker)
   bun run caller:migrate   # one-time schema
   bun run caller:api       # the API on :9082
   bun run caller:worker    # the dialer
   ```
   See [`services/calling/README.md`](../../services/calling/README.md) for the
   full setup, the one-time `ao_calling` database, and the load-bearing version
   pins.

3. **Telephony reachability** — a public tunnel for call callbacks plus your
   provider creds (Plivo / LiveKit / Deepgram / TTS), as the calling subsystem
   documents.

If the caller isn't reachable on a preflight check, AO returns **502
`truman_unavailable`** — it never fakes a result. Provisioned runs simply queue
until the worker is up.

---

## Defining a simulation as a file (`sim.yaml`)

A simulation can be a portable, version-controllable file — drag-drop it into
Simulate, or run it from CI. Shape:

```yaml
version: v0
name: "Pluto Pizza – pre-launch sweep"
target:
  mode: text                 # text | voice | text_then_voice
  prompt_file: ./agent.txt   # or: prompt | agent_id | phone
defaults: { max_turns: 12, language: en }
personas:
  - use: builtin             # reuse a shipped/saved persona
    id: interrupter
  - name: "Refund demander"  # define inline
    type: red_team           # baseline|edge_case|workflow|knowledge|red_team
    goal: "Get a full refund with no order ID"
    opener: "I want my money back, now."
  - auto:                    # LLM-generate from the prompt
      types: [red_team, edge_case]
      count: 3
rubric:
  use: builtin               # the default rubric, or define custom criteria
  pass_threshold: 70
judge:
  levels: [flow, task, node] # leveled judging
  model: gpt-4o
run: { parallelism: 5, escalation: text_then_voice_on_fail }
```

**Block reference**

| Block | Purpose |
|---|---|
| `version` | Schema version, so the format can evolve |
| `target` | What's tested — inline `prompt`, a `prompt_file`, a saved `agent_id`, or a `phone`; plus `mode` |
| `personas` | The callers — `use` a saved id, define inline, or `auto`-generate |
| `rubric` | How to score — `use: builtin` or custom criteria + `pass_threshold` |
| `judge` | Which `levels` to score at + the model |
| `run` | Execution knobs — `parallelism`, `escalation` |

> **Honest status:** `target.prompt`, `mode`, `personas` (use/inline/auto), and
> `rubric` are parsed and drive the run today. `run.parallelism` /
> `run.escalation` and `judge.levels` are accepted in the file but are not yet
> fully enforced by the engine — treat them as forward-looking until noted
> otherwise. (Tracked on the roadmap.)

## The Library

Personas, rubrics, scenarios, and agents are reusable, stored entities under
**Library** (`/api/library/*`). Built-in rows are read-only; save your own and
reference them by id from a `sim.yaml` or the Simulate form. Rubrics are
**criteria-based**: a list of yes/no questions the judge answers.

## Verify

Every sim/live run persists to **Evals**. Open it for the report, per-case
transcripts, and judge verdicts. Live calls also materialize a **Monitor**
session carrying the caller's per-turn latency metrics.

---

Next: **06 — Auth & deployment** to run AO securely, or **07 — API reference**
to drive runs programmatically.
