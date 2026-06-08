# Run evals in CI

Gate your releases on agent quality. Each `pytest` or `vitest` run streams into
AO as one **eval run**, with every test surfacing as an **eval case** —
function-call assertions, LLM-judge verdicts, agent handoffs, and failure detail
captured automatically. The runs land in the **Evals** tab alongside your sims
and live calls, on one timeline.

You install a language-native plugin; it POSTs once to AO at the end of the test
session. No assertions change — your existing test suite just becomes
observable.

## Choose your plugin

| Framework | Package | Registry | Install |
|---|---|---|---|
| pytest (Python) | `pytest-agent-observability` | PyPI | `pip install pytest-agent-observability` |
| Vitest (Node/TS) | `vitest-agent-observability` | npm | `npm install -D vitest-agent-observability` |

Authoritative, always-current setup (config, wiring, how to invoke from an HTTP
server) lives in each plugin's README:
- [`plugins/pytest-agent-observability/README.md`](../../plugins/pytest-agent-observability/README.md)
- [`plugins/vitest-agent-observability/README.md`](../../plugins/vitest-agent-observability/README.md)

Runnable reference suites — simple agents, a multi-agent banking example,
LLM-generated scenarios, and the HTTP runners — are under
[`plugins/examples/`](../../plugins/examples/README.md). Start by copying one.

## pytest — quick start

```bash
pip install pytest-agent-observability
```

The plugin auto-attaches (via entry points). Point it at AO with environment
variables, then run pytest as usual:

```bash
export AGENT_OBSERVABILITY_URL=https://your-ao-host:9090
# If AO has basic auth enabled, also:
export AGENT_OBSERVABILITY_USER=your_user
export AGENT_OBSERVABILITY_PASS=your_pass

pytest
```

At `pytest_sessionfinish` the plugin makes **one** `POST /observability/evals/v0`
with the whole run. If `AGENT_OBSERVABILITY_URL` is unset, the plugin **no-ops**
— so the same suite runs locally without uploading.

### Configuration (env vars)

| Variable | Purpose |
|---|---|
| `AGENT_OBSERVABILITY_URL` | AO base URL. **Unset = don't upload.** |
| `AGENT_OBSERVABILITY_USER` / `_PASS` | Basic auth, if AO requires it |
| `AGENT_OBSERVABILITY_AGENT_ID` | Tag the run with the agent under test |
| `AGENT_OBSERVABILITY_ACCOUNT_ID` | Tag the run with an account/tenant |
| `AGENT_OBSERVABILITY_TIMEOUT` | Upload timeout (seconds) |
| `AGENT_OBSERVABILITY_MAX_RETRIES` | Upload retry count |
| `AGENT_OBSERVABILITY_FALLBACK_DIR` | Write the payload here if the upload fails |

> Upload is fire-and-forget with retries; a network blip never fails your test
> run. See the plugin README for the current, complete list.

## Vitest — quick start

```bash
npm install -D vitest-agent-observability
```

Wire it in your Vitest config as a reporter (or via the `setup` import — see the
plugin README), then set the same `AGENT_OBSERVABILITY_*` env vars and run
`vitest`. Each invocation lands as one eval run.

## LiveKit-judge evals

If your agent is built on LiveKit, you can drive it text-only in a test and judge
the conversation with the **same LLM judge** AO uses everywhere (one
`_LLMJudge` per criterion). These runs land in Evals tagged
`framework=livekit` / `testing_framework=pytest`, with per-criterion verdicts
and the full conversation. The reference suite in `plugins/examples/` shows the
pattern.

## Verify

Run your suite, then open **Evals** in the dashboard — your run appears with its
pass/fail counts. Click in for per-case transcripts, judge verdicts, and failure
detail. Or via the API:

```bash
curl https://your-ao-host:9090/api/evals -u "$AO_USER:$AO_PASS"
```

## CI wiring (sketch)

Set `AGENT_OBSERVABILITY_URL` (and auth, if any) as CI secrets, then run your
tests as a normal step. Example (GitHub Actions):

```yaml
- name: Run agent evals
  env:
    AGENT_OBSERVABILITY_URL: ${{ secrets.AO_URL }}
    AGENT_OBSERVABILITY_USER: ${{ secrets.AO_USER }}
    AGENT_OBSERVABILITY_PASS: ${{ secrets.AO_PASS }}
    AGENT_OBSERVABILITY_AGENT_ID: my-support-agent
  run: pytest        # or: npx vitest run
```

The test exit code still gates the build; AO gives you the history, diffs over
time, and shareable per-case detail behind it.

---

Next: **04 — Run a simulation or live call** to QA an agent *before* it ever
reaches CI.
