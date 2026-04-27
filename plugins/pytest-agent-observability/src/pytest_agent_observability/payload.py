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
    account_id: Optional[str],
    finished_at: float,
) -> dict:
    framework = detect_framework()
    return {
        "version": "v0",
        "run": {
            "run_id": collector.run_id,
            "account_id": account_id,
            "agent_id": agent_id,
            "framework": framework[0] if framework else None,
            "framework_version": framework[1] if framework else None,
            "testing_framework": TESTING_FRAMEWORK,
            "testing_framework_version": _pkg_version("pytest"),
            "started_at": collector.started_at,
            "finished_at": finished_at,
            "ci": collector.ci,
        },
        "cases": [_case_to_dict(c) for c in collector.cases],
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
