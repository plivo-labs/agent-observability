from __future__ import annotations

from pytest_agent_observability.ci import detect_ci


CI_ENV_VARS = [
    "GITHUB_ACTIONS", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
    "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_REF",
    "GITLAB_CI", "CI_JOB_URL", "CI_COMMIT_SHA", "CI_COMMIT_REF_NAME", "CI_COMMIT_MESSAGE",
    "CIRCLECI", "CIRCLE_BUILD_URL", "CIRCLE_SHA1", "CIRCLE_BRANCH",
    "BUILDKITE", "BUILDKITE_BUILD_URL", "BUILDKITE_COMMIT", "BUILDKITE_BRANCH", "BUILDKITE_MESSAGE",
]


def _clear(monkeypatch):
    for v in CI_ENV_VARS:
        monkeypatch.delenv(v, raising=False)


def test_no_ci(monkeypatch):
    _clear(monkeypatch)
    assert detect_ci() is None


def test_github(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.com")
    monkeypatch.setenv("GITHUB_REPOSITORY", "plivo-labs/demo")
    monkeypatch.setenv("GITHUB_RUN_ID", "12345")
    monkeypatch.setenv("GITHUB_SHA", "abc123")
    monkeypatch.setenv("GITHUB_REF_NAME", "main")

    ci = detect_ci()
    assert ci is not None
    assert ci["provider"] == "github"
    assert ci["run_url"] == "https://github.com/plivo-labs/demo/actions/runs/12345"
    assert ci["git_sha"] == "abc123"
    assert ci["git_branch"] == "main"


def test_gitlab(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("GITLAB_CI", "true")
    monkeypatch.setenv("CI_JOB_URL", "https://gitlab.com/p/d/-/jobs/1")
    monkeypatch.setenv("CI_COMMIT_SHA", "deadbeef")
    monkeypatch.setenv("CI_COMMIT_REF_NAME", "feature/x")
    monkeypatch.setenv("CI_COMMIT_MESSAGE", "Fix thing")

    ci = detect_ci()
    assert ci is not None
    assert ci["provider"] == "gitlab"
    assert ci["run_url"] == "https://gitlab.com/p/d/-/jobs/1"
    assert ci["git_sha"] == "deadbeef"
    assert ci["commit_message"] == "Fix thing"


def test_circleci(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("CIRCLECI", "true")
    monkeypatch.setenv("CIRCLE_BUILD_URL", "https://circleci.com/jobs/9")
    monkeypatch.setenv("CIRCLE_SHA1", "cafebabe")
    monkeypatch.setenv("CIRCLE_BRANCH", "main")

    ci = detect_ci()
    assert ci is not None
    assert ci["provider"] == "circleci"
    assert ci["git_sha"] == "cafebabe"


def test_empty_values_are_stripped(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    # Intentionally only sha, no repo/run_id — run_url should be absent.
    monkeypatch.setenv("GITHUB_SHA", "abc")

    ci = detect_ci()
    assert ci is not None
    assert "run_url" not in ci
    assert ci["git_sha"] == "abc"
