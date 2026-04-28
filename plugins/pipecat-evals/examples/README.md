# pipecat-evals Examples

These examples are normal pytest files. From this package directory, run:

```bash
PYTHONPATH=src pytest examples -q
```

They are intentionally deterministic and do not require real LLM credentials.

- `test_manual_run_result.py` demonstrates the assertion and judge API by
  constructing a transcript directly.
- `test_mock_pipecat_agent.py` demonstrates `AgentSession.start(...)` and
  `await session.run(...)` using a tiny in-memory Pipecat-compatible pipeline.

In a real Pipecat application, replace the in-memory pipeline with your actual
Pipecat pipeline factory and keep the same `AgentSession`/`RunResult` assertions.
