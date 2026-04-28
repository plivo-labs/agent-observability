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
        from pytest_agent_observability import uploader

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
        from pytest_agent_observability import uploader
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


def test_terminal_summary_prints_run_id_and_dashboard_url(
    pytester: pytest.Pytester, monkeypatch
):
    """Successful upload should print run_id + clickable dashboard URL."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    pytester.makeconftest(
        """
        from pytest_agent_observability import uploader
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
    assert "http://stub:9090/evals/" in stdout


def test_terminal_summary_reports_failure_and_fallback_path(
    pytester: pytest.Pytester, monkeypatch
):
    """Failed upload should surface the run_id and where the payload landed locally."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    pytester.makeconftest(
        """
        from pytest_agent_observability import uploader
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
        from pytest_agent_observability import capture
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
        from pytest_agent_observability import uploader
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


def test_pipecat_evals_autocapture_and_judge(pytester: pytest.Pytester, monkeypatch, tmp_path):
    """pipecat-evals results are captured without importing Pipecat itself."""
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    captured = tmp_path / "payload.json"

    pytester.makeconftest(
        f"""
        from pytest_agent_observability import uploader
        def _stub(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured)!r}).write_text(json.dumps(payload))
            return True
        uploader.upload = _stub

        import sys, types
        from dataclasses import dataclass

        session_mod = types.ModuleType('pipecat_evals.session')
        run_result_mod = types.ModuleType('pipecat_evals.run_result')
        hooks_mod = types.ModuleType('pipecat_evals.hooks')
        run_hooks = []
        judgment_hooks = []

        def register_run_result_hook(callback):
            run_hooks.append(callback)
            return lambda: run_hooks.remove(callback) if callback in run_hooks else None

        def register_judgment_hook(callback):
            judgment_hooks.append(callback)
            return lambda: judgment_hooks.remove(callback) if callback in judgment_hooks else None

        hooks_mod.register_run_result_hook = register_run_result_hook
        hooks_mod.register_judgment_hook = register_judgment_hook

        @dataclass
        class FakeMsg:
            role: str = 'assistant'
            text_content: str = 'pipecat hi'
            interrupted: bool = False

        @dataclass
        class FakeEvent:
            item: FakeMsg
            type: str = 'message'

        class FakeRunResult:
            __pipecat_evals_run_result__ = True

            def __init__(self, user_input):
                self._user_input = user_input
                self.user_input = user_input
                self.events = [FakeEvent(item=FakeMsg())]

        class AgentSession:
            async def run(self, *, user_input, **_):
                result = FakeRunResult(user_input=user_input)
                for hook in list(run_hooks):
                    hook(result)
                return result

        class JudgeResult:
            def __init__(self, success=True, reasoning='ok'):
                self.success = success
                self.reasoning = reasoning
                self.verdict = 'pass' if success else 'fail'

        class ChatMessageAssert:
            def __init__(self):
                self.judgment = None

            async def judge(self, _judge=None, *, intent):
                self.judgment = JudgeResult(success=True, reasoning='looks good')
                for hook in list(judgment_hooks):
                    hook(intent, self.judgment)
                return self

        session_mod.AgentSession = AgentSession
        session_mod.ORIGINAL_RUN = AgentSession.run
        run_result_mod.ChatMessageAssert = ChatMessageAssert
        run_result_mod.ORIGINAL_JUDGE = ChatMessageAssert.judge
        pkg = types.ModuleType('pipecat_evals')
        pkg.session = session_mod
        pkg.run_result = run_result_mod
        pkg.hooks = hooks_mod
        sys.modules['pipecat_evals'] = pkg
        sys.modules['pipecat_evals.session'] = session_mod
        sys.modules['pipecat_evals.run_result'] = run_result_mod
        sys.modules['pipecat_evals.hooks'] = hooks_mod
        """
    )
    pytester.makepyfile(
        """
        import pytest
        from pipecat_evals.session import AgentSession
        from pipecat_evals.run_result import ChatMessageAssert

        @pytest.mark.asyncio
        async def test_no_manual_capture_needed():
            sess = AgentSession()
            result = await sess.run(user_input="ping")
            await ChatMessageAssert().judge(None, intent="greets via pipecat")
            assert result is not None

        def test_pipecat_integration_uses_hooks_not_monkeypatches():
            import pipecat_evals.run_result as rr
            import pipecat_evals.session as session
            assert ChatMessageAssert.judge is rr.ORIGINAL_JUDGE
            assert AgentSession.run is session.ORIGINAL_RUN
        """
    )
    pytester.runpytest("-p", "agent_observability").assert_outcomes(passed=2)
    payload = json.loads(captured.read_text())
    assert payload["run"]["framework"] == "pipecat"
    assert payload["run"]["testing_framework"] == "pytest"

    case = {case["name"]: case for case in payload["cases"]}["test_no_manual_capture_needed"]
    assert case["user_input"] == "ping"
    assert case["events"][0]["content"] == "pipecat hi"
    assert case["judgments"] == [{
        "intent": "greets via pipecat",
        "verdict": "pass",
        "reasoning": "looks good",
    }]


def test_pipecat_evals_failed_judge_is_recorded(pytester: pytest.Pytester, monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    captured = tmp_path / "payload.json"

    pytester.makeconftest(
        f"""
        from pytest_agent_observability import uploader
        def _stub(payload, config, *, fallback_dir=None):
            import json
            from pathlib import Path
            Path({str(captured)!r}).write_text(json.dumps(payload))
            return True
        uploader.upload = _stub

        import sys, types
        from dataclasses import dataclass

        session_mod = types.ModuleType('pipecat_evals.session')
        run_result_mod = types.ModuleType('pipecat_evals.run_result')
        hooks_mod = types.ModuleType('pipecat_evals.hooks')
        run_hooks = []
        judgment_hooks = []

        def register_run_result_hook(callback):
            run_hooks.append(callback)
            return lambda: run_hooks.remove(callback) if callback in run_hooks else None

        def register_judgment_hook(callback):
            judgment_hooks.append(callback)
            return lambda: judgment_hooks.remove(callback) if callback in judgment_hooks else None

        hooks_mod.register_run_result_hook = register_run_result_hook
        hooks_mod.register_judgment_hook = register_judgment_hook

        @dataclass
        class FakeMsg:
            role: str = 'assistant'
            text_content: str = 'nope'
            interrupted: bool = False

        @dataclass
        class FakeEvent:
            item: FakeMsg
            type: str = 'message'

        class FakeRunResult:
            __pipecat_evals_run_result__ = True
            _user_input = 'ping'
            events = [FakeEvent(item=FakeMsg())]

        class AgentSession:
            async def run(self, *, user_input, **_):
                result = FakeRunResult()
                result._user_input = user_input
                result.user_input = user_input
                for hook in list(run_hooks):
                    hook(result)
                return result

        class JudgeResult:
            success = False
            verdict = 'fail'
            reasoning = 'not good enough'

        class ChatMessageAssert:
            async def judge(self, _judge=None, *, intent):
                for hook in list(judgment_hooks):
                    hook(intent, JudgeResult())
                raise AssertionError('Judgement failed: not good enough')

        session_mod.AgentSession = AgentSession
        run_result_mod.ChatMessageAssert = ChatMessageAssert
        pkg = types.ModuleType('pipecat_evals')
        pkg.session = session_mod
        pkg.run_result = run_result_mod
        pkg.hooks = hooks_mod
        sys.modules['pipecat_evals'] = pkg
        sys.modules['pipecat_evals.session'] = session_mod
        sys.modules['pipecat_evals.run_result'] = run_result_mod
        sys.modules['pipecat_evals.hooks'] = hooks_mod
        """
    )
    pytester.makepyfile(
        """
        import pytest
        from pipecat_evals.session import AgentSession
        from pipecat_evals.run_result import ChatMessageAssert

        @pytest.mark.asyncio
        async def test_failed_judge_is_uploaded():
            sess = AgentSession()
            await sess.run(user_input="ping")
            await ChatMessageAssert().judge(None, intent="quality bar")
        """
    )

    pytester.runpytest("-p", "agent_observability").assert_outcomes(failed=1)
    payload = json.loads(captured.read_text())
    assert payload["run"]["framework"] == "pipecat"

    case = payload["cases"][0]
    assert case["status"] == "failed"
    assert case["failure"]["kind"] == "judge_failed"
    assert case["judgments"] == [{
        "intent": "quality bar",
        "verdict": "fail",
        "reasoning": "not good enough",
    }]


def test_capture_attaches_events_to_case(pytester: pytest.Pytester, monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "http://stub:9090")
    captured = tmp_path / "payload.json"

    pytester.makeconftest(
        f"""
        from pytest_agent_observability import uploader
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
        from pytest_agent_observability import capture

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
