"""Integration tests for the pytest plugin using pytester.

These spawn pytest-in-pytest so we can observe the plugin's hooks in isolation.
"""

from __future__ import annotations

import json

import pytest


pytest_plugins = ["pytester"]


def test_plugin_noop_when_url_not_set(pytester: pytest.Pytester, monkeypatch):
    """With no AGENT_OBSERVABILITY_URL, the plugin must not interfere."""
    monkeypatch.delenv("AGENT_OBSERVABILITY_URL", raising=False)
    pytester.makepyfile(
        """
        def test_passes():
            assert True
        def test_fails():
            assert False
        """
    )
    result = pytester.runpytest("-p", "agent_observability", "-v")
    result.assert_outcomes(passed=1, failed=1)


def test_plugin_uploads_on_sessionfinish(pytester: pytest.Pytester, monkeypatch, tmp_path):
    """With AGENT_OBSERVABILITY_URL set, the upload attempt should fire.

    We stub the uploader to capture the payload instead of a real HTTP call.
    """
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_ID", "unit-test-agent")

    captured = tmp_path / "captured-payload.json"

    pytester.makeconftest(
        f"""
        from agent_observability.livekit.pytest import uploader

        _orig = uploader.upload

        def _stub(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured)!r}).write_text(json.dumps(payload))
            return True

        uploader.upload = _stub
        """
    )
    pytester.makepyfile(
        """
        def test_one(): pass
        def test_two(): assert True
        def test_skip():
            import pytest
            pytest.skip("nope")
        """
    )
    result = pytester.runpytest("-p", "agent_observability", "-v")
    result.assert_outcomes(passed=2, skipped=1)

    assert captured.exists(), "uploader stub should have written the payload"
    payload = json.loads(captured.read_text())
    assert payload["version"] == "v0"
    assert payload["run"]["testing_framework"] == "pytest"
    assert payload["run"]["agent_id"] == "unit-test-agent"
    assert len(payload["cases"]) == 3
    # All three cases should appear with correct status.
    by_name = {c["name"]: c for c in payload["cases"]}
    assert by_name["test_one"]["status"] == "passed"
    assert by_name["test_two"]["status"] == "passed"
    assert by_name["test_skip"]["status"] == "skipped"


def test_plugin_records_failure(pytester: pytest.Pytester, monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    captured = tmp_path / "payload.json"

    pytester.makeconftest(
        f"""
        from agent_observability.livekit.pytest import uploader
        def _stub(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured)!r}).write_text(json.dumps(payload))
            return True
        uploader.upload = _stub
        """
    )
    pytester.makepyfile(
        """
        def test_boom():
            assert 1 == 2, "one is not two"
        """
    )
    pytester.runpytest("-p", "agent_observability", "-v").assert_outcomes(failed=1)

    payload = json.loads(captured.read_text())
    case = payload["cases"][0]
    assert case["status"] == "failed"
    assert case["failure"] is not None
    assert case["failure"]["kind"] == "assertion"
    assert "one is not two" in case["failure"]["message"]


def test_terminal_summary_prints_run_id_and_agent_scoped_dashboard_url(
    pytester: pytest.Pytester, monkeypatch
):
    """Successful upload prints the v2 agent-scoped dashboard URL.

    The v2 dashboard routes are agent-first: simulation eval runs live at
    /agents/:agentId/simulation-evals/:runId, not at the legacy /evals/:id.
    """
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.setenv(
        "AGENT_OBSERVABILITY_AGENT_ID",
        "9c2f7e3d-4b8a-4d2e-9f1b-stubagent01",
    )
    pytester.makeconftest(
        """
        from agent_observability.livekit.pytest import uploader
        def _stub(payload, config, *, fallback_dir=None):
            return True
        uploader.upload = _stub
        """
    )
    pytester.makepyfile(
        """
        def test_one(): pass
        """
    )
    result = pytester.runpytest("-p", "agent_observability", "-v")
    result.assert_outcomes(passed=1)

    stdout = result.stdout.str()
    assert "agent-observability" in stdout
    assert "Run uploaded:" in stdout
    assert "View at:" in stdout
    assert (
        "http://stub:9090/agents/9c2f7e3d-4b8a-4d2e-9f1b-stubagent01/simulation-evals/"
        in stdout
    )


def test_terminal_summary_falls_back_to_agents_list_without_agent_id(
    pytester: pytest.Pytester, monkeypatch
):
    """No agent_id → link goes to the agents-list root, not the legacy /evals/."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.delenv("AGENT_OBSERVABILITY_AGENT_ID", raising=False)
    pytester.makeconftest(
        """
        from agent_observability.livekit.pytest import uploader
        def _stub(payload, config, *, fallback_dir=None):
            return True
        uploader.upload = _stub
        """
    )
    pytester.makepyfile(
        """
        def test_one(): pass
        """
    )
    result = pytester.runpytest("-p", "agent_observability", "-v")
    result.assert_outcomes(passed=1)

    stdout = result.stdout.str()
    assert "View at:      http://stub:9090/agents" in stdout
    # Legacy /evals/<id> URL must never appear.
    assert "/evals/" not in stdout.replace("/observability/evals/", "")


def test_terminal_summary_reports_failure_and_fallback_path(
    pytester: pytest.Pytester, monkeypatch
):
    """Failed upload should surface the run_id and where the payload landed locally."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    pytester.makeconftest(
        """
        from agent_observability.livekit.pytest import uploader
        def _stub(payload, config, *, fallback_dir=None):
            return False  # upload failed
        uploader.upload = _stub
        """
    )
    pytester.makepyfile(
        """
        def test_one(): pass
        """
    )
    result = pytester.runpytest("-p", "agent_observability", "-v")
    result.assert_outcomes(passed=1)

    stdout = result.stdout.str()
    assert "Run upload failed:" in stdout
    assert "Payload saved:" in stdout


def test_capture_without_plugin_is_safe(pytester: pytest.Pytester, monkeypatch):
    """capture() called in a test with no URL configured should not break."""
    monkeypatch.delenv("AGENT_OBSERVABILITY_URL", raising=False)
    pytester.makepyfile(
        """
        from agent_observability.livekit.pytest import capture
        def test_runs():
            # Fake run result — capture should silently no-op.
            capture(object())
            assert True
        """
    )
    pytester.runpytest("-p", "agent_observability").assert_outcomes(passed=1)


def test_autocapture_via_session_run_wrapper(pytester: pytest.Pytester, monkeypatch, tmp_path):
    """The plugin monkey-patches AgentSession.run, so users never have to call capture()."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    captured = tmp_path / "payload.json"

    pytester.makeconftest(
        f"""
        from agent_observability.livekit.pytest import uploader
        def _stub(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured)!r}).write_text(json.dumps(payload))
            return True
        uploader.upload = _stub

        # Install a fake AgentSession so we can exercise the autocapture path
        # without pulling real livekit-agents into the test.
        import sys, types
        from dataclasses import dataclass

        fake_mod = types.ModuleType('livekit.agents.voice.agent_session')

        @dataclass
        class FakeMsg:
            role: str = 'assistant'
            text_content: str = 'autocaptured hi'
            interrupted: bool = False

        @dataclass
        class FakeEvent:
            item: FakeMsg
            type: str = 'message'

        class FakeRunResult:
            def __init__(self, user_input):
                self._user_input = user_input
                self.events = [FakeEvent(item=FakeMsg())]

        class AgentSession:
            def run(self, *, user_input, **_):
                return FakeRunResult(user_input=user_input)

        fake_mod.AgentSession = AgentSession
        sys.modules['livekit'] = types.ModuleType('livekit')
        sys.modules['livekit.agents'] = types.ModuleType('livekit.agents')
        sys.modules['livekit.agents.voice'] = types.ModuleType('livekit.agents.voice')
        sys.modules['livekit.agents.voice.agent_session'] = fake_mod
        """
    )
    pytester.makepyfile(
        """
        from livekit.agents.voice.agent_session import AgentSession

        def test_no_manual_capture_needed():
            sess = AgentSession()
            result = sess.run(user_input="ping")
            # NOTE: no `capture(...)` call here. Autocapture should still record.
            assert result is not None
        """
    )
    pytester.runpytest("-p", "agent_observability").assert_outcomes(passed=1)
    payload = json.loads(captured.read_text())
    case = payload["cases"][0]
    assert case["user_input"] == "ping"
    assert len(case["events"]) == 1
    ev = case["events"][0]
    assert ev["type"] == "message"
    assert ev["role"] == "assistant"
    assert ev["content"] == "autocaptured hi"
    assert ev["interrupted"] is False


def test_capture_attaches_events_to_case(pytester: pytest.Pytester, monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    captured = tmp_path / "payload.json"

    pytester.makeconftest(
        f"""
        from agent_observability.livekit.pytest import uploader
        def _stub(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured)!r}).write_text(json.dumps(payload))
            return True
        uploader.upload = _stub
        """
    )
    pytester.makepyfile(
        """
        from dataclasses import dataclass
        from agent_observability.livekit.pytest import capture

        @dataclass
        class FakeMsg:
            role: str = "assistant"
            text_content: str = "hello"
            interrupted: bool = False

        @dataclass
        class FakeEvent:
            item: FakeMsg
            type: str = "message"

        class FakeRunResult:
            _user_input = "hi there"
            events = [FakeEvent(item=FakeMsg())]

        def test_with_capture():
            capture(FakeRunResult())
            assert True
        """
    )
    pytester.runpytest("-p", "agent_observability").assert_outcomes(passed=1)
    payload = json.loads(captured.read_text())
    case = payload["cases"][0]
    assert case["user_input"] == "hi there"
    assert len(case["events"]) == 1
    ev = case["events"][0]
    assert ev["type"] == "message"
    assert ev["role"] == "assistant"
    assert ev["content"] == "hello"
    assert ev["interrupted"] is False


# ── agent_name resolution ────────────────────────────────────────────────────
#
# The plugin reads agent_name from (1) `--agent-observability-agent-name`,
# falling back to (2) `AGENT_OBSERVABILITY_AGENT_NAME`, falling back to
# (3) None. Without these the obs dashboard can only show the opaque
# agent_id; with them, the agents table renders a human label.


def _capture_payload_conftest(captured_path) -> str:
    """conftest stub that writes the payload the plugin would upload."""
    return f"""
        from agent_observability.livekit.pytest import uploader

        def _stub(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured_path)!r}).write_text(json.dumps(payload))
            return True

        uploader.upload = _stub
    """


def test_agent_name_from_cli_flag_wins_over_env(
    pytester: pytest.Pytester, monkeypatch, tmp_path
):
    """--agent-observability-agent-name takes precedence over the env var."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_ID", "agent-uuid")
    monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_NAME", "env-name")

    captured = tmp_path / "payload.json"
    pytester.makeconftest(_capture_payload_conftest(captured))
    pytester.makepyfile("def test_one(): pass")

    pytester.runpytest(
        "-p",
        "agent_observability",
        "--agent-observability-agent-name=flag-name",
        "-v",
    ).assert_outcomes(passed=1)

    payload = json.loads(captured.read_text())
    assert payload["run"]["agent_name"] == "flag-name"


def test_agent_name_from_env_when_no_flag(
    pytester: pytest.Pytester, monkeypatch, tmp_path
):
    """AGENT_OBSERVABILITY_AGENT_NAME is the fallback for the flag."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_ID", "agent-uuid")
    monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_NAME", "env-name")

    captured = tmp_path / "payload.json"
    pytester.makeconftest(_capture_payload_conftest(captured))
    pytester.makepyfile("def test_one(): pass")

    pytester.runpytest("-p", "agent_observability", "-v").assert_outcomes(passed=1)

    payload = json.loads(captured.read_text())
    assert payload["run"]["agent_name"] == "env-name"


def test_agent_name_absent_when_neither_set(
    pytester: pytest.Pytester, monkeypatch, tmp_path
):
    """No flag + no env → agent_name is null in the payload."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_ID", "agent-uuid")
    monkeypatch.delenv("AGENT_OBSERVABILITY_AGENT_NAME", raising=False)

    captured = tmp_path / "payload.json"
    pytester.makeconftest(_capture_payload_conftest(captured))
    pytester.makepyfile("def test_one(): pass")

    pytester.runpytest("-p", "agent_observability", "-v").assert_outcomes(passed=1)

    payload = json.loads(captured.read_text())
    assert payload["run"]["agent_name"] is None
