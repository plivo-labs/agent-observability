"""Build the eval payload (v0) that agent-observability accepts."""

from __future__ import annotations

import importlib
import importlib.metadata
from typing import Optional, Tuple

from .collector import RunCollector, CaseRecord


# Test framework that ran this suite — `pytest`. Constant.
TESTING_FRAMEWORK = "pytest"

# Probe order matches Plivo's typical deployment: livekit first
# (current default), then pipecat. New agent frameworks can be added
# here without touching anything else.
_AGENT_FRAMEWORK_PROBES: list[tuple[str, str]] = [
    ("livekit", "livekit-agents"),
    ("pipecat", "pipecat-ai"),
]


def detect_framework() -> Optional[Tuple[str, Optional[str]]]:
    """Probe installed agent-framework packages and return ``(name,
    version)``. Returns ``None`` when nothing detectable is installed.
    """
    for name, pkg in _AGENT_FRAMEWORK_PROBES:
        version = _pkg_version(pkg)
        if version is not None:
            return (name, version)
    return None


def build_payload(
    *,
    collector: RunCollector,
    agent_id: Optional[str],
    agent_name: Optional[str],
    account_id: Optional[str],
    finished_at: Optional[float],
    status: str = "completed",
    name: Optional[str] = None,
    cases: Optional[list] = None,
) -> dict:
    """Build the eval payload (v0).

    Streaming flow:
      • pytest_sessionstart  → status='running', cases=None (defaults to
                               collector.cases which is empty at that point).
      • Background flusher   → status='running', cases=<subset of newly
                               finished cases>. Server's ON CONFLICT
                               (case_id) DO NOTHING + post-insert
                               aggregation make these partial payloads
                               additive — each just adds its cases to
                               the run, totals recompute from eval_cases.
      • pytest_sessionfinish → status from exitstatus, cases=None
                               (collector.cases has the full set).

    `name` is an optional human-readable label so the dashboard can
    show "Nightly smoke" / "PR #482" instead of just a UUID prefix.

    `cases` overrides collector.cases when provided — used by the
    streaming flusher to POST a subset.
    """
    framework = detect_framework()
    case_list = cases if cases is not None else collector.cases
    return {
        "version": "v0",
        "run": {
            "run_id": collector.run_id,
            "name": name,
            "account_id": account_id,
            "agent_id": agent_id,
            "agent_name": agent_name,
            "framework": framework[0] if framework else None,
            "framework_version": framework[1] if framework else None,
            "testing_framework": TESTING_FRAMEWORK,
            "testing_framework_version": _pkg_version("pytest"),
            "started_at": collector.started_at,
            "finished_at": finished_at,
            "status": status,
            "ci": collector.ci,
        },
        "cases": [_case_to_dict(c) for c in case_list],
    }


def _case_to_dict(c: CaseRecord) -> dict:
    return {
        "case_id": c.case_id,
        "name": c.name,
        "file": c.file,
        "status": c.status,
        "duration_ms": c.duration_ms,
        "user_input": c.user_input,
        "events": c.events,
        "judgments": c.judgments,
        "failure": c.failure,
    }


def _pkg_version(name: str) -> Optional[str]:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:
        return None
