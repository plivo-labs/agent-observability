from __future__ import annotations

from pytest_agent_observability import collector as col
from pytest_agent_observability.payload import build_payload, TESTING_FRAMEWORK


def test_build_payload_shape():
    rc = col.RunCollector.new(started_at=100.0, ci={"provider": "github"})
    rc.add_case(col.CaseRecord(
        case_id="case-1",
        name="test_one",
        file="tests/test_demo.py",
        status="passed",
        duration_ms=1234,
        user_input="hello",
        events=[{"type": "message", "role": "assistant", "content": "hi"}],
        judgments=[{"intent": "greets", "verdict": "pass", "reasoning": ""}],
        failure=None,
    ))

    payload = build_payload(
        collector=rc,
        agent_id="support-bot",
        agent_name="Support Bot",
        account_id="acct-1",
        finished_at=200.0,
    )

    assert payload["version"] == "v0"
    assert payload["run"]["testing_framework"] == TESTING_FRAMEWORK
    # testing_framework_version comes from `pytest`'s installed metadata —
    # the test is running under pytest so this must resolve.
    assert payload["run"]["testing_framework_version"] is not None
    assert payload["run"]["agent_id"] == "support-bot"
    assert payload["run"]["agent_name"] == "Support Bot"
    assert payload["run"]["account_id"] == "acct-1"
    assert payload["run"]["started_at"] == 100.0
    assert payload["run"]["finished_at"] == 200.0
    assert payload["run"]["ci"] == {"provider": "github"}
    assert len(payload["cases"]) == 1

    c = payload["cases"][0]
    assert c["case_id"] == "case-1"
    assert c["name"] == "test_one"
    assert c["status"] == "passed"
    assert c["events"][0]["type"] == "message"
    assert c["judgments"][0]["verdict"] == "pass"


def test_detect_framework_returns_livekit_when_installed():
    """Plugin tests run inside an env where livekit-agents may or may
    not be installed depending on the matrix. Either result is valid;
    we just ensure the field shape is consistent.
    """
    rc = col.RunCollector.new(started_at=0.0)
    payload = build_payload(
        collector=rc,
        agent_id=None,
        agent_name=None,
        account_id=None,
        finished_at=0.0,
    )
    fw = payload["run"]["framework"]
    assert fw is None or fw in {"livekit", "pipecat"}
    if fw is not None:
        assert payload["run"]["framework_version"] is not None


def test_build_payload_handles_empty_cases():
    rc = col.RunCollector.new(started_at=0.0)
    payload = build_payload(collector=rc, agent_id=None, agent_name=None, account_id=None, finished_at=0.0)
    assert payload["cases"] == []
    assert payload["run"]["agent_id"] is None
    assert payload["run"]["agent_name"] is None
    assert payload["run"]["account_id"] is None


def test_build_payload_default_status_is_completed():
    """Legacy single-POST flow: no status kwarg → 'completed' in payload."""
    rc = col.RunCollector.new(started_at=0.0)
    payload = build_payload(
        collector=rc, agent_id=None, agent_name=None, account_id=None, finished_at=10.0,
    )
    assert payload["run"]["status"] == "completed"


def test_build_payload_status_running_with_null_finished_at():
    """Streaming flow: session-start POST carries status='running' and a
    null finished_at. All other run fields (account_id, agent_id,
    framework, ci, started_at) must still be present so the server can
    persist the run header with full identity info."""
    rc = col.RunCollector.new(started_at=100.0, ci={"provider": "github", "git_sha": "abc"})
    payload = build_payload(
        collector=rc,
        agent_id="support-bot",
        agent_name="Support Bot",
        account_id="acct-1",
        finished_at=None,
        status="running",
    )
    assert payload["run"]["status"] == "running"
    assert payload["run"]["finished_at"] is None
    # Identity fields preserved on the running ping — server-side ON
    # CONFLICT DO UPDATE relies on this so the terminal POST can use
    # COALESCE rather than fighting nulls.
    assert payload["run"]["agent_id"] == "support-bot"
    assert payload["run"]["agent_name"] == "Support Bot"
    assert payload["run"]["account_id"] == "acct-1"
    assert payload["run"]["ci"] == {"provider": "github", "git_sha": "abc"}
    assert payload["run"]["started_at"] == 100.0
    assert payload["run"]["testing_framework"] == TESTING_FRAMEWORK
    assert payload["cases"] == []  # no cases yet at session-start


def test_build_payload_status_failed():
    """`failed` is a passive signal the plugin can pass through when the
    suite itself didn't complete cleanly."""
    rc = col.RunCollector.new(started_at=0.0)
    payload = build_payload(
        collector=rc, agent_id=None, agent_name=None, account_id=None,
        finished_at=50.0, status="failed",
    )
    assert payload["run"]["status"] == "failed"


def test_build_payload_includes_name_when_set():
    """Optional run name flows through verbatim — server-side schema is
    loose, so whatever the plugin chose to label this run with is what
    the dashboard surfaces."""
    rc = col.RunCollector.new(started_at=0.0)
    payload = build_payload(
        collector=rc, agent_id=None, agent_name=None, account_id=None,
        finished_at=10.0, name="Nightly smoke",
    )
    assert payload["run"]["name"] == "Nightly smoke"


def test_build_payload_name_defaults_to_none():
    """No name kwarg → run.name is None. Server stores NULL; dashboard
    renders an em-dash. Back-compat with plugins that don't know about
    the new option."""
    rc = col.RunCollector.new(started_at=0.0)
    payload = build_payload(
        collector=rc, agent_id=None, agent_name=None, account_id=None,
        finished_at=10.0,
    )
    assert payload["run"]["name"] is None


def test_build_payload_cases_override_uses_subset(monkeypatch):
    """Streaming flusher: build_payload(cases=[X]) uses the given
    subset instead of collector.cases. Collector keeps the full set
    for the terminal POST; the flusher just wants 'these N newly
    finished'."""
    rc = col.RunCollector.new(started_at=0.0)
    rc.add_case(col.CaseRecord(
        case_id="case-1", name="t1", file=None, status="passed",
        duration_ms=10, user_input=None, events=[], judgments=[], failure=None,
    ))
    rc.add_case(col.CaseRecord(
        case_id="case-2", name="t2", file=None, status="passed",
        duration_ms=15, user_input=None, events=[], judgments=[], failure=None,
    ))
    only_one = [rc.cases[0]]

    payload = build_payload(
        collector=rc, agent_id=None, agent_name=None, account_id=None,
        finished_at=None, status="running", cases=only_one,
    )

    # collector still has 2 cases; payload should only carry the override.
    assert len(rc.cases) == 2
    assert len(payload["cases"]) == 1
    assert payload["cases"][0]["case_id"] == "case-1"


def test_build_payload_cases_none_falls_back_to_collector():
    """Default behaviour — no cases= kwarg → uses collector.cases.
    Existing single-POST callers shouldn't see a behavior change."""
    rc = col.RunCollector.new(started_at=0.0)
    rc.add_case(col.CaseRecord(
        case_id="case-A", name="t", file=None, status="passed",
        duration_ms=5, user_input=None, events=[], judgments=[], failure=None,
    ))

    payload = build_payload(
        collector=rc, agent_id=None, agent_name=None, account_id=None,
        finished_at=10.0,
    )
    assert len(payload["cases"]) == 1
    assert payload["cases"][0]["case_id"] == "case-A"
