"""Tests for _install_judge_group_wrapper — JudgeGroup.evaluate interception."""

from __future__ import annotations

import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import pytest_agent_observability.collector as col
from pytest_agent_observability.plugin import _install_judge_group_wrapper


# ---------------------------------------------------------------------------
# Helpers: build a minimal fake livekit.agents.evals.evaluation module tree
# so _install_judge_group_wrapper can import JudgeGroup without the real SDK.
# ---------------------------------------------------------------------------


def _make_fake_livekit():
    """Inject a minimal livekit stub into sys.modules, return JudgeGroup class."""

    class FakeJudgmentResult:
        def __init__(self, verdict: str, reasoning: str, instructions: str = ""):
            self.verdict = verdict
            self.reasoning = reasoning
            self.instructions = instructions

    class FakeEvaluationResult:
        def __init__(self, judgments: dict):
            self.judgments = judgments

    class FakeJudgeGroup:
        async def evaluate(self, chat_ctx):  # pragma: no cover — replaced by wrapper
            raise NotImplementedError

    # Build the module hierarchy livekit -> agents -> evals -> evaluation
    livekit_mod = types.ModuleType("livekit")
    agents_mod = types.ModuleType("livekit.agents")
    evals_mod = types.ModuleType("livekit.agents.evals")
    evaluation_mod = types.ModuleType("livekit.agents.evals.evaluation")

    evaluation_mod.JudgeGroup = FakeJudgeGroup
    evals_mod.evaluation = evaluation_mod
    agents_mod.evals = evals_mod
    livekit_mod.agents = agents_mod

    sys.modules["livekit"] = livekit_mod
    sys.modules["livekit.agents"] = agents_mod
    sys.modules["livekit.agents.evals"] = evals_mod
    sys.modules["livekit.agents.evals.evaluation"] = evaluation_mod

    return FakeJudgeGroup, FakeEvaluationResult, FakeJudgmentResult


def _remove_fake_livekit():
    for key in list(sys.modules):
        if key.startswith("livekit"):
            del sys.modules[key]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_livekit(request):
    """Remove any livekit stub after each test."""
    yield
    _remove_fake_livekit()


@pytest.fixture()
def fake_livekit():
    return _make_fake_livekit()


@pytest.mark.asyncio
async def test_record_judgment_called_for_each_judgment(fake_livekit):
    FakeJudgeGroup, FakeEvaluationResult, FakeJudgmentResult = fake_livekit

    pass_jr = FakeJudgmentResult(verdict="pass", reasoning="looks good")
    fail_jr = FakeJudgmentResult(verdict="fail", reasoning="wrong answer")
    fake_result = FakeEvaluationResult(
        judgments={"accuracy": pass_jr, "coherence": fail_jr}
    )

    FakeJudgeGroup.evaluate = AsyncMock(return_value=fake_result)

    _install_judge_group_wrapper()

    calls: list[dict] = []

    def capture_judgment(**kwargs):
        calls.append(kwargs)

    with patch("pytest_agent_observability.plugin.col._record_judgment", side_effect=capture_judgment):
        group = FakeJudgeGroup()
        returned = await group.evaluate(chat_ctx=MagicMock())

    assert returned is fake_result, "wrapper must return original result unchanged"
    assert len(calls) == 2

    by_name = {c["name"]: c for c in calls}

    assert by_name["accuracy"]["verdict"] == "pass"
    assert by_name["accuracy"]["score"] == 1.0
    assert by_name["accuracy"]["intent"] == "accuracy"
    assert by_name["accuracy"]["reasoning"] == "looks good"

    assert by_name["coherence"]["verdict"] == "fail"
    assert by_name["coherence"]["score"] == 0.0
    assert by_name["coherence"]["intent"] == "coherence"
    assert by_name["coherence"]["reasoning"] == "wrong answer"


@pytest.mark.asyncio
async def test_maybe_verdict_scores_half(fake_livekit):
    FakeJudgeGroup, FakeEvaluationResult, FakeJudgmentResult = fake_livekit

    maybe_jr = FakeJudgmentResult(verdict="maybe", reasoning="unclear")
    fake_result = FakeEvaluationResult(judgments={"safety": maybe_jr})

    FakeJudgeGroup.evaluate = AsyncMock(return_value=fake_result)

    _install_judge_group_wrapper()

    calls: list[dict] = []

    with patch("pytest_agent_observability.plugin.col._record_judgment", side_effect=lambda **kw: calls.append(kw)):
        group = FakeJudgeGroup()
        await group.evaluate(chat_ctx=MagicMock())

    assert calls[0]["score"] == 0.5


@pytest.mark.asyncio
async def test_original_result_preserved(fake_livekit):
    """Wrapper is transparent — original return value flows through unchanged."""
    FakeJudgeGroup, FakeEvaluationResult, FakeJudgmentResult = fake_livekit

    sentinel = FakeEvaluationResult(judgments={})
    FakeJudgeGroup.evaluate = AsyncMock(return_value=sentinel)

    _install_judge_group_wrapper()

    with patch("pytest_agent_observability.plugin.col._record_judgment"):
        group = FakeJudgeGroup()
        result = await group.evaluate(chat_ctx=MagicMock())

    assert result is sentinel


def test_no_op_when_livekit_unavailable():
    """_install_judge_group_wrapper must not raise when livekit is absent."""
    # Ensure livekit is not importable.
    _remove_fake_livekit()
    # Insert a dummy that causes ImportError on the submodule.
    sys.modules["livekit"] = None  # type: ignore[assignment]

    try:
        _install_judge_group_wrapper()  # should not raise
    finally:
        _remove_fake_livekit()
