from __future__ import annotations

from pytest_agent_observability import collector as col
from pytest_agent_observability.payload import build_payload, FRAMEWORK, SDK


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
        account_id="acct-1",
        finished_at=200.0,
    )

    assert payload["version"] == "v0"
    assert payload["run"]["framework"] == FRAMEWORK
    assert payload["run"]["sdk"] == SDK
    assert payload["run"]["agent_id"] == "support-bot"
    assert payload["run"]["account_id"] == "acct-1"
    assert payload["run"]["started_at"] == 100.0
    assert payload["run"]["finished_at"] == 200.0
    assert payload["run"]["ci"] == {"provider": "github"}
    assert payload["run"]["framework_version"] is not None  # pytest is installed
    assert len(payload["cases"]) == 1

    c = payload["cases"][0]
    assert c["case_id"] == "case-1"
    assert c["name"] == "test_one"
    assert c["status"] == "passed"
    assert c["events"][0]["type"] == "message"
    assert c["judgments"][0]["verdict"] == "pass"


def test_build_payload_handles_empty_cases():
    rc = col.RunCollector.new(started_at=0.0)
    payload = build_payload(collector=rc, agent_id=None, account_id=None, finished_at=0.0)
    assert payload["cases"] == []
    assert payload["run"]["agent_id"] is None
    assert payload["run"]["account_id"] is None
