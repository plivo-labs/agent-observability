# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "fastapi>=0.110",
#     "uvicorn[standard]>=0.29",
#     "pydantic>=2.0",
#     "pytest>=7.0",
#     "pytest-asyncio>=0.21",
#     "pytest-agent-observability",
#     "livekit-agents>=1.5",
#     "livekit-plugins-openai>=1.5",
#     "openai>=1.40",
# ]
#
# # Local override — uncomment to test against the in-tree plugin.
# # [tool.uv.sources]
# # pytest-agent-observability = { path = "../../pytest-agent-observability" }
# ///
"""FastAPI server that exposes test runs over HTTP.

Two endpoints, same underlying evals:

  - `POST /run/pytest`    — invokes `pytest.main([...])` **in-process** via
                            pytest's Python API, against
                            `pytest_generated_agent.py`. A tiny collector
                            plugin captures per-test outcomes and durations.

  - `POST /run/scenarios` — skips the pytest framing entirely and calls
                            `pytest_generated_agent.run_all()`, which
                            reuses the same generated scenarios and the same
                            `PizzaShopAgent`. Returns raw judged results.

Both routes return JSON — no subprocess, no shell, single process, single
thread of control (though evals fan out under `asyncio.gather`).

Run (inline deps via PEP 723 — no prior install step needed):

    export OPENAI_API_KEY=sk-...
    uv run plugins/examples/fastapi_runner.py

Then:

    curl -X POST http://localhost:8080/run/pytest -H content-type:application/json \\
         -d '{"n": 5}'
    curl -X POST http://localhost:8080/run/scenarios -H content-type:application/json \\
         -d '{"n": 5}'
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any, AsyncIterator, Optional

# ── Logging ─────────────────────────────────────────────────────────────────

# Use a named logger so uvicorn can route it alongside its own access logs.
# Level defaults to INFO; override with LOG_LEVEL=DEBUG for wire-level detail.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("fastapi_runner")

import pytest
from fastapi import Body, FastAPI, HTTPException

# Pre-import the LiveKit OpenAI plugin on the main thread at module load.
# `pytest.main()` runs in a FastAPI threadpool worker for sync endpoints,
# and LiveKit's plugin registry raises `Plugins must be registered on the
# main thread` if the first import happens off-main-thread. Doing the
# import here — at uvicorn startup, on the main thread — registers the
# plugin safely; the worker-thread import later is a no-op re-import.
from livekit.plugins import openai as _lk_openai_preload  # noqa: F401
from pydantic import BaseModel, Field

# ── Pytest in-process collector plugin ──────────────────────────────────────


class _ResultsCollector:
    """Pytest plugin that captures per-test outcomes.

    We hook `pytest_runtest_logreport` because it fires once per phase
    (setup/call/teardown) per test, which is exactly the granularity needed
    to capture a fail from an assertion (call phase) or a setup error
    (setup phase) without double-counting.
    """

    def __init__(self) -> None:
        self.cases: dict[str, dict[str, Any]] = {}
        self.started_at: float = 0.0
        self.ended_at: float = 0.0

    def pytest_sessionstart(self, session):  # noqa: ARG002 — pytest hook
        self.started_at = time.time()

    def pytest_sessionfinish(self, session, exitstatus):  # noqa: ARG002
        self.ended_at = time.time()

    def pytest_runtest_logreport(self, report):
        # nodeid looks like: path/to/file.py::test_fn[param]
        case = self.cases.setdefault(
            report.nodeid,
            {"nodeid": report.nodeid, "phases": {}, "outcome": "unknown"},
        )
        case["phases"][report.when] = {
            "outcome": report.outcome,
            "duration_s": report.duration,
            "longrepr": str(report.longrepr) if report.failed else None,
        }
        # Final outcome: fail if any phase failed; error if setup errored; else
        # the call-phase outcome.
        if report.failed and report.when != "call":
            case["outcome"] = "error"
        elif report.when == "call":
            case["outcome"] = report.outcome
        elif (
            case["outcome"] == "unknown"
            and report.when == "setup"
            and report.outcome == "skipped"
        ):
            case["outcome"] = "skipped"

    def summary(self) -> dict[str, Any]:
        cases = list(self.cases.values())
        by_outcome: dict[str, int] = {}
        for c in cases:
            by_outcome[c["outcome"]] = by_outcome.get(c["outcome"], 0) + 1
        return {
            "total": len(cases),
            "by_outcome": by_outcome,
            "duration_s": (self.ended_at - self.started_at) if self.started_at else 0,
            "cases": cases,
        }


# ── FastAPI app ─────────────────────────────────────────────────────────────


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown hook. Replaces the deprecated @app.on_event('startup')."""
    log.info(
        "fastapi_runner ready: examples_dir=%s openai_key_set=%s "
        "observability_url=%s agent_id=%s",
        _EXAMPLES_DIR,
        bool(os.environ.get("OPENAI_API_KEY")),
        os.environ.get("AGENT_OBSERVABILITY_URL") or "(unset)",
        os.environ.get("AGENT_OBSERVABILITY_AGENT_ID") or "(unset)",
    )
    yield
    log.info("fastapi_runner shutting down")


app = FastAPI(
    title="agent-observability example runner",
    description=(
        "Triggers LiveKit-agent eval runs in-process. See /docs for the two endpoints."
    ),
    lifespan=_lifespan,
)


# Make sure sibling modules (scenario_runner, pytest_generated_agent) are
# importable whether the server is launched from the repo root or from the
# examples dir.
_EXAMPLES_DIR = Path(__file__).resolve().parent
import sys

if str(_EXAMPLES_DIR) not in sys.path:
    sys.path.insert(0, str(_EXAMPLES_DIR))


class RunRequest(BaseModel):
    n: int = Field(
        default=10,
        ge=1,
        le=25,
        description="How many scenarios the LLM should generate.",
    )
    # Which generated-agent test file to invoke under pytest. Defaults to the
    # one that ships with this example.
    test_path: Optional[str] = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/run/pytest")
def run_pytest(
    req: RunRequest = Body(default_factory=RunRequest),
) -> dict[str, Any]:
    """Run the generated-agent test file **in-process** via pytest's API.

    We set AGENT_OBSERVABILITY_GENERATED_N so the pytest file's collection
    hook generates the requested number of scenarios. pytest.main() runs
    in the current process — no subprocess, no extra thread.
    """
    if not os.environ.get("OPENAI_API_KEY"):
        log.error("/run/pytest refused: OPENAI_API_KEY is not set")
        raise HTTPException(
            status_code=400,
            detail=(
                "OPENAI_API_KEY is not set on the server; cannot generate "
                "or judge scenarios."
            ),
        )

    os.environ["AGENT_OBSERVABILITY_GENERATED_N"] = str(req.n)
    test_path = req.test_path or str(_EXAMPLES_DIR / "pytest_generated_agent.py")

    log.info("/run/pytest start: n=%d test_path=%s", req.n, test_path)
    started = time.monotonic()

    collector = _ResultsCollector()
    # `-q` keeps pytest's own stdout terse; `--no-header` removes banner noise.
    # `-p no:cacheprovider` stops pytest from writing `.pytest_cache/` into the
    # working directory when this endpoint is hit from a non-git dir.
    exit_code = pytest.main(
        [test_path, "-q", "--no-header", "-p", "no:cacheprovider"],
        plugins=[collector],
    )

    summary = collector.summary()
    elapsed = time.monotonic() - started
    log.info(
        "/run/pytest done: exit=%d total=%d outcomes=%s elapsed=%.2fs",
        int(exit_code),
        summary["total"],
        summary["by_outcome"],
        elapsed,
    )
    # DEBUG-level log for per-case detail — enable with LOG_LEVEL=DEBUG.
    for case in summary["cases"]:
        log.debug("  case: %s → %s", case["nodeid"], case["outcome"])

    return {
        "exit_code": int(exit_code),
        "passed": int(exit_code) == 0,
        **summary,
    }


@app.post("/run/scenarios")
async def run_scenarios_direct(
    req: RunRequest = Body(default_factory=RunRequest),
) -> dict[str, Any]:
    """Bypass pytest entirely. Reuses the same generated scenarios and
    the same agent as the pytest file — just returns judged results directly."""
    if not os.environ.get("OPENAI_API_KEY"):
        log.error("/run/scenarios refused: OPENAI_API_KEY is not set")
        raise HTTPException(
            status_code=400,
            detail="OPENAI_API_KEY is not set.",
        )

    log.info("/run/scenarios start: n=%d", req.n)
    started = time.monotonic()

    # Reload scenarios with the requested count. This hits OpenAI.
    import pytest_generated_agent as gen
    from scenario_runner import summarize

    scenarios = gen.reload_scenarios(req.n)
    log.info(
        "/run/scenarios generated %d scenarios: %s",
        len(scenarios),
        [s.name for s in scenarios],
    )

    results = await gen.run_all()
    out = summarize(results)
    elapsed = time.monotonic() - started
    log.info(
        "/run/scenarios done: total=%d passed=%d maybe=%d failed=%d elapsed=%.2fs",
        out["total"],
        out["passed"],
        out["maybe"],
        out["failed"],
        elapsed,
    )
    for r in results:
        log.debug(
            "  scenario: %s verdict=%s tools=%s reason=%s",
            r.scenario.name,
            r.verdict,
            r.tools_called,
            (r.judge_reason or "")[:120],
        )

    return out


# ── Convenience: `python fastapi_runner.py` runs uvicorn ────────────────────

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "fastapi_runner:app",
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "8080")),
        reload=False,
    )
