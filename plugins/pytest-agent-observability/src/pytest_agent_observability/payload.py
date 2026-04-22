"""Build the eval payload (v0) that agent-observability accepts."""

from __future__ import annotations

import importlib
import importlib.metadata
from typing import Optional

from .collector import RunCollector, CaseRecord


FRAMEWORK = "pytest"
SDK = "livekit-agents"


def build_payload(
    *,
    collector: RunCollector,
    agent_id: Optional[str],
    account_id: Optional[str],
    finished_at: float,
) -> dict:
    return {
        "version": "v0",
        "run": {
            "run_id": collector.run_id,
            "account_id": account_id,
            "agent_id": agent_id,
            "framework": FRAMEWORK,
            "framework_version": _pkg_version("pytest"),
            "sdk": SDK,
            "sdk_version": _pkg_version("livekit-agents"),
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
