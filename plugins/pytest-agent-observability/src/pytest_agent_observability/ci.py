"""Best-effort CI environment detection.

Returns a dict suitable for the `ci` field in the eval payload. Absent keys
are simply not emitted — the dashboard renders whatever is present.
"""

from __future__ import annotations

import os
import subprocess
from typing import Optional


def detect_ci() -> Optional[dict]:
    if os.getenv("GITHUB_ACTIONS") == "true":
        return _github()
    if os.getenv("GITLAB_CI") == "true":
        return _gitlab()
    if os.getenv("CIRCLECI") == "true":
        return _circleci()
    if os.getenv("BUILDKITE") == "true":
        return _buildkite()
    return _local_git()


def _local_git() -> Optional[dict]:
    def _git(*args: str) -> Optional[str]:
        try:
            return subprocess.check_output(
                ["git", *args], text=True, stderr=subprocess.DEVNULL
            ).strip()
        except (subprocess.CalledProcessError, FileNotFoundError):
            return None

    sha = _git("rev-parse", "HEAD")
    if not sha:
        return None
    return _clean({
        "provider": "local",
        "git_sha": sha,
        "git_branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
        "commit_message": _git("log", "-1", "--pretty=%s"),
    })


def _github() -> dict:
    server = os.getenv("GITHUB_SERVER_URL", "https://github.com")
    repo = os.getenv("GITHUB_REPOSITORY", "")
    run_id = os.getenv("GITHUB_RUN_ID", "")
    run_url = f"{server}/{repo}/actions/runs/{run_id}" if repo and run_id else None
    return _clean({
        "provider": "github",
        "run_url": run_url,
        "git_sha": os.getenv("GITHUB_SHA"),
        "git_branch": os.getenv("GITHUB_REF_NAME") or os.getenv("GITHUB_REF"),
        "commit_message": None,
    })


def _gitlab() -> dict:
    return _clean({
        "provider": "gitlab",
        "run_url": os.getenv("CI_JOB_URL"),
        "git_sha": os.getenv("CI_COMMIT_SHA"),
        "git_branch": os.getenv("CI_COMMIT_REF_NAME"),
        "commit_message": os.getenv("CI_COMMIT_MESSAGE"),
    })


def _circleci() -> dict:
    return _clean({
        "provider": "circleci",
        "run_url": os.getenv("CIRCLE_BUILD_URL"),
        "git_sha": os.getenv("CIRCLE_SHA1"),
        "git_branch": os.getenv("CIRCLE_BRANCH"),
        "commit_message": None,
    })


def _buildkite() -> dict:
    return _clean({
        "provider": "buildkite",
        "run_url": os.getenv("BUILDKITE_BUILD_URL"),
        "git_sha": os.getenv("BUILDKITE_COMMIT"),
        "git_branch": os.getenv("BUILDKITE_BRANCH"),
        "commit_message": os.getenv("BUILDKITE_MESSAGE"),
    })


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v}
