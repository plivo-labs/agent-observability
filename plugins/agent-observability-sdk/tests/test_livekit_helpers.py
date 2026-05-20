"""Tests for ``agent_observability.livekit`` helpers."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from agent_observability.livekit import (
    init_observability,
    ensure_observability_url,
    run_judges_on_report,
)


# ── Fakes ─────────────────────────────────────────────────────────────────────


class FakeTagger:
    """Stand-in for ``ctx.tagger``. Records every ``add`` call verbatim."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any] | None]] = []

    def add(self, name: str, metadata: dict[str, Any] | None = None) -> None:
        self.calls.append((name, metadata))

    def names(self) -> list[str]:
        return [n for n, _ in self.calls]


class FakeReport:
    """``ctx.make_session_report()`` only ever has its ``.chat_history`` read."""

    def __init__(self, chat_history: Any) -> None:
        self.chat_history = chat_history


# ── init_observability ─────────────────────────────────────────────────


class TestInitObservability:
    def test_emits_full_bundle_when_all_kwargs_supplied(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        tagger = FakeTagger()
        resolved = init_observability(
            tagger,
            agent_id="agent-uuid-1",
            agent_name="bot",
            account_id="acct-7",
            transport="text",
        )

        assert resolved == "agent-uuid-1"
        assert tagger.names() == [
            "agent.session",
            "agent_id:agent-uuid-1",
            "account_id:acct-7",
            "agent.name:bot",
            "transport:text",
        ]
        # The wrapper carries everything in metadata for raw_report fidelity.
        wrapper = tagger.calls[0]
        assert wrapper[0] == "agent.session"
        assert wrapper[1] == {
            "agent_id": "agent-uuid-1",
            "agent_name": "bot",
            "account_id": "acct-7",
            "transport": "text",
        }

    def test_emits_only_agent_id_when_optional_kwargs_omitted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        tagger = FakeTagger()
        init_observability(tagger, agent_id="agent-uuid-2")

        # Wrapper + atomic agent_id — nothing else.
        assert tagger.names() == [
            "agent.session",
            "agent_id:agent-uuid-2",
        ]
        assert tagger.calls[0][1] == {"agent_id": "agent-uuid-2"}

    def test_falls_back_to_env_when_kwarg_omitted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_ID", "env-agent")
        tagger = FakeTagger()
        resolved = init_observability(tagger)
        assert resolved == "env-agent"
        assert "agent_id:env-agent" in tagger.names()

    def test_raises_when_agent_id_unresolvable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        monkeypatch.delenv("AGENT_OBSERVABILITY_AGENT_ID", raising=False)
        tagger = FakeTagger()
        with pytest.raises(ValueError, match="agent_id is required"):
            init_observability(tagger)
        # No tags should be emitted on the failure path.
        assert tagger.calls == []

    def test_raises_when_observability_url_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("LIVEKIT_OBSERVABILITY_URL", raising=False)
        monkeypatch.delenv("AGENT_OBSERVABILITY_URL", raising=False)
        tagger = FakeTagger()
        with pytest.raises(RuntimeError, match="no upload target"):
            init_observability(tagger, agent_id="a1")
        # URL check happens before tag emission — no tags on failure.
        assert tagger.calls == []

    def test_url_check_runs_before_agent_id_check(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Both misconfigurations present — URL error wins because it
        # short-circuits first. Lets the worker fix the more fundamental
        # config issue before the surface one.
        monkeypatch.delenv("LIVEKIT_OBSERVABILITY_URL", raising=False)
        monkeypatch.delenv("AGENT_OBSERVABILITY_URL", raising=False)
        monkeypatch.delenv("AGENT_OBSERVABILITY_AGENT_ID", raising=False)
        tagger = FakeTagger()
        with pytest.raises(RuntimeError, match="no upload target"):
            init_observability(tagger)  # no agent_id either

    def test_kwarg_wins_over_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        monkeypatch.setenv("AGENT_OBSERVABILITY_AGENT_ID", "env-loser")
        tagger = FakeTagger()
        resolved = init_observability(tagger, agent_id="kwarg-winner")
        assert resolved == "kwarg-winner"
        assert "agent_id:kwarg-winner" in tagger.names()
        assert "agent_id:env-loser" not in tagger.names()

    def test_extra_metadata_rides_on_wrapper_only(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        tagger = FakeTagger()
        init_observability(
            tagger,
            agent_id="a1",
            extra_metadata={"deployment": "staging", "region": "us-east-1"},
        )
        wrapper = tagger.calls[0]
        assert wrapper[1] == {
            "agent_id": "a1",
            "deployment": "staging",
            "region": "us-east-1",
        }
        # No atomic deployment: or region: tag — only the agent_id one.
        assert tagger.names() == ["agent.session", "agent_id:a1"]


# ── ensure_observability_url ─────────────────────────────────────────────────


class TestEnsureObservabilityUrl:
    def test_returns_livekit_var_when_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        monkeypatch.delenv("AGENT_OBSERVABILITY_URL", raising=False)
        assert ensure_observability_url() == "https://obs.example.com"

    def test_falls_back_and_mirrors_to_livekit_var(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("LIVEKIT_OBSERVABILITY_URL", raising=False)
        monkeypatch.setenv("AGENT_OBSERVABILITY_URL", "https://obs.example.com")

        url = ensure_observability_url()
        assert url == "https://obs.example.com"
        # The fallback is mirrored back so LiveKit's upload code reads it.
        import os

        assert os.environ["LIVEKIT_OBSERVABILITY_URL"] == "https://obs.example.com"

    def test_returns_none_when_neither_set(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.delenv("LIVEKIT_OBSERVABILITY_URL", raising=False)
        monkeypatch.delenv("AGENT_OBSERVABILITY_URL", raising=False)

        with caplog.at_level(logging.WARNING, logger="agent_observability.livekit"):
            url = ensure_observability_url()

        assert url is None
        assert any(
            "LIVEKIT_OBSERVABILITY_URL" in record.message
            and record.levelno == logging.WARNING
            for record in caplog.records
        )

    def test_emits_info_log_when_set(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.setenv("LIVEKIT_OBSERVABILITY_URL", "https://obs.example.com")
        with caplog.at_level(logging.INFO, logger="agent_observability.livekit"):
            ensure_observability_url()
        assert any(
            "https://obs.example.com" in r.message and r.levelno == logging.INFO
            for r in caplog.records
        )


# ── run_judges_on_report ─────────────────────────────────────────────────────


class FakeJudge:
    """Minimal stand-in matching the ``Judge`` protocol the JudgeGroup uses."""

    def __init__(self, name: str, verdict: str = "pass") -> None:
        self._name = name
        self._verdict = verdict

    @property
    def name(self) -> str:
        return self._name

    async def evaluate(self, *, chat_ctx: Any, **_: Any) -> Any:
        from livekit.agents.evals import JudgmentResult

        return JudgmentResult(verdict=self._verdict, reasoning="ok")


class FakeLLM:
    """Sentinel LLM. We never actually call into it — we patch JudgeGroup."""

    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class TestRunJudgesOnReport:
    async def test_returns_none_on_empty_judges(self) -> None:
        report = FakeReport(chat_history=object())
        assert await run_judges_on_report(report, judges=[]) is None

    async def test_passes_through_evaluation_result(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Patch JudgeGroup.evaluate to a stub so we don't need a real LLM.
        from agent_observability.livekit import evaluation as ev_mod

        class FakeJudgmentResult:
            def __init__(self, score: float = 1.0) -> None:
                self.score = score
                self.judgments = {
                    "accuracy": type("J", (), {"verdict": "pass"})(),
                    "safety": type("J", (), {"verdict": "pass"})(),
                }

        class FakeGroup:
            def __init__(self, *, llm: Any, judges: Any) -> None:
                self.llm = llm
                self.judges = judges

            async def evaluate(self, _chat: Any) -> Any:
                return FakeJudgmentResult(score=0.95)

        monkeypatch.setattr(ev_mod, "JudgeGroup", FakeGroup)

        llm = FakeLLM()
        report = FakeReport(chat_history="<history>")
        result = await run_judges_on_report(
            report,
            judges=[FakeJudge("accuracy"), FakeJudge("safety")],
            llm=llm,  # caller owns the LLM
        )
        assert result is not None and result.score == 0.95
        # Caller-owned LLM must NOT be closed by the helper.
        assert llm.closed is False

    async def test_closes_owned_llm(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from agent_observability.livekit import evaluation as ev_mod

        class FakeGroup:
            def __init__(self, *, llm: Any, judges: Any) -> None:
                self.llm = llm

            async def evaluate(self, _chat: Any) -> Any:
                return type("R", (), {"score": 1.0, "judgments": {}})()

        monkeypatch.setattr(ev_mod, "JudgeGroup", FakeGroup)

        # Patch the helper that builds the default LLM so we can capture
        # the instance and assert aclose() ran on it. Avoids needing the
        # real livekit.plugins.openai package installed in test.
        captured: dict[str, FakeLLM] = {}

        def fake_default_llm() -> FakeLLM:
            inst = FakeLLM()
            captured["llm"] = inst
            return inst

        monkeypatch.setattr(ev_mod, "_default_judge_llm", fake_default_llm)

        report = FakeReport(chat_history="<history>")
        await run_judges_on_report(
            report,
            judges=[FakeJudge("accuracy")],
        )
        # Owned LLM must be closed in the finally block.
        assert captured["llm"].closed is True

    async def test_swallows_evaluation_errors_and_returns_none(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from agent_observability.livekit import evaluation as ev_mod

        class ExplodingGroup:
            def __init__(self, **_: Any) -> None:
                pass

            async def evaluate(self, _: Any) -> Any:
                raise RuntimeError("boom")

        monkeypatch.setattr(ev_mod, "JudgeGroup", ExplodingGroup)

        with caplog.at_level(logging.ERROR, logger="agent_observability.livekit"):
            result = await run_judges_on_report(
                FakeReport(chat_history=None),
                judges=[FakeJudge("a")],
                llm=FakeLLM(),
            )

        # The contract is to swallow, log, and return None — a session-end
        # hook shouldn't blow up the worker because a judge LLM hiccupped.
        assert result is None
        assert any("Judge evaluation failed" in r.message for r in caplog.records)

    async def test_invokes_on_result_callback(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from agent_observability.livekit import evaluation as ev_mod

        class FakeGroup:
            def __init__(self, **_: Any) -> None:
                pass

            async def evaluate(self, _: Any) -> Any:
                return type("R", (), {"score": 1.0, "judgments": {}})()

        monkeypatch.setattr(ev_mod, "JudgeGroup", FakeGroup)

        captured: list[Any] = []

        async def on_result(res: Any) -> None:
            captured.append(res)

        await run_judges_on_report(
            FakeReport(chat_history=None),
            judges=[FakeJudge("a")],
            llm=FakeLLM(),
            on_result=on_result,
        )
        assert len(captured) == 1
        assert captured[0].score == 1.0
