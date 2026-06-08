# Integrating Agent Observability

These guides are for a **team adopting Agent Observability (AO)** — pointing your
voice agent at it, running QA against it, and (later) embedding its views in your
own product. They assume you did **not** write AO; if you're working *on* AO, see
the repo root `README.md` and `CLAUDE.md`.

## What AO gives you

One application, three capabilities, one timeline:

| Capability | What you get | You set up |
|---|---|---|
| **Monitor** | Every real/production call: per-turn latency (STT/LLM/TTS), transcript, audio, tags, pass/fail outcomes | Point your agent's telemetry at AO |
| **Evals** | CI test-suite results — runs & cases, judge verdicts, failure detail | Install the pytest / vitest plugin |
| **Simulate / Live** | Persona-driven QA *before* launch — text sims and real phone calls, scored by an LLM judge | Use the dashboard (a prompt is enough) |

The same personas, rubrics, and judge power all three, and a simulation, a CI
eval, and a production call all land in the same database and UI.

## The guides

| # | Guide | For | Status |
|---|---|---|---|
| 01 | [Quickstart — adopt AO in 15 minutes](./01-quickstart.md) | Everyone — start here | ✅ |
| 02 | [Send your agent's telemetry](./02-send-telemetry.md) | Monitor production calls | ✅ |
| 03 | [Run evals in CI (pytest / vitest)](./03-run-evals-in-ci.md) | Gate releases on agent quality | ✅ |
| 04 | [Run a simulation or live call](./04-run-a-simulation-or-live-call.md) | QA an agent before launch | ✅ |
| 05 | Embed AO in your product | Put Monitor/Simulate in your own UI | ⏳ needs UI work first |
| 06 | [Auth & deployment](./06-auth-and-deployment.md) | Ops — secure + deploy AO | ✅ |
| 07 | [API reference](./07-api-reference.md) | Build against AO's API directly | ✅ |

> Phase 1 (guides 01–04, 06–07) is ready for review. Guide 05 (embedding)
> depends on the pluggable-UI work (Track A) and is intentionally last.
