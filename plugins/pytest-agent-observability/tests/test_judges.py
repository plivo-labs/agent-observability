"""Tests for the judges module."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest

from pytest_agent_observability import judges
from pytest_agent_observability.judges import JudgeInput, Rubric
from pytest_agent_observability.collector import _record_judgment, _set_current_test, _reset_current_test, pop_state


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class MockLLM:
    """LLMClient that returns a pre-configured JSON string."""

    def __init__(self, response: dict | str) -> None:
        self._response = response if isinstance(response, str) else json.dumps(response)
        self.call_count = 0

    def evaluate(self, prompt: str) -> str:
        self.call_count += 1
        return self._response


def _run_in_test(test_id: str, fn):
    """Run fn inside a fake test context so _record_judgment can store state."""
    token = _set_current_test(test_id)
    try:
        return fn()
    finally:
        _reset_current_test(token)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_hallucination_single_criterion_records_one_judgment():
    llm = MockLLM({"hallucination": {"score": 0.9, "reason": "All facts supported"}})
    input = JudgeInput(response="The sky is blue.")

    judgments_before = []
    test_id = "test_hallucination_single"

    _run_in_test(test_id, lambda: judges.hallucination(input, llm))

    state = pop_state(test_id)
    assert state is not None
    assert len(state.judgments) == 1
    j = state.judgments[0]
    assert j["intent"] == "hallucination"
    assert j["verdict"] == "pass"
    assert j["score"] == pytest.approx(0.9)
    assert j["name"] == "hallucination"
    assert llm.call_count == 1


def test_evaluate_multi_criterion_single_llm_call():
    llm = MockLLM({
        "hallucination": {"score": 0.85, "reason": "No fabrication"},
        "adherence": {"score": 0.9, "reason": "Followed instructions"},
    })
    input = JudgeInput(
        response="I can help with that.",
        system_prompt="Be concise.",
    )
    test_id = "test_multi_criterion"

    _run_in_test(
        test_id,
        lambda: judges.evaluate(input, llm, criteria=["hallucination", "adherence"]),
    )

    state = pop_state(test_id)
    assert state is not None
    # Two judgments recorded
    assert len(state.judgments) == 2
    names = {j["intent"] for j in state.judgments}
    assert names == {"hallucination", "adherence"}
    # Only ONE LLM call
    assert llm.call_count == 1


def test_threshold_fail_when_score_below_threshold():
    llm = MockLLM({"hallucination": {"score": 0.6, "reason": "Minor issue"}})
    input = JudgeInput(response="Some response")
    test_id = "test_threshold_fail"

    _run_in_test(test_id, lambda: judges.hallucination(input, llm, threshold=0.7))

    state = pop_state(test_id)
    assert state is not None
    assert state.judgments[0]["verdict"] == "fail"
    assert state.judgments[0]["score"] == pytest.approx(0.6)
    assert state.judgments[0]["threshold"] == pytest.approx(0.7)


def test_json_parse_failure_records_judge_failed():
    llm = MockLLM("This is not JSON at all, completely unparseable!!!")
    input = JudgeInput(response="Some response")
    test_id = "test_parse_failure"

    result = _run_in_test(test_id, lambda: judges.evaluate(input, llm))

    state = pop_state(test_id)
    assert state is not None
    assert len(state.judgments) == 1
    j = state.judgments[0]
    assert j["intent"] == "judge_failed"
    assert j["verdict"] == "error"
    assert result == {}


def test_prompt_contains_rubric_criteria_and_steps():
    from pytest_agent_observability.judges.prompt import build_prompt
    from pytest_agent_observability.judges.rubrics import HALLUCINATION_RUBRIC

    input = JudgeInput(
        response="Test response",
        system_prompt="Be helpful",
        context="Some context",
    )
    prompt = build_prompt([HALLUCINATION_RUBRIC], input)

    assert HALLUCINATION_RUBRIC.criteria in prompt
    for step in HALLUCINATION_RUBRIC.steps:
        assert step in prompt
    assert HALLUCINATION_RUBRIC.name in prompt
    # Input slots present
    assert "Be helpful" in prompt
    assert "Some context" in prompt
    assert "Test response" in prompt


def test_custom_rubric():
    custom_rubric = Rubric(
        name="conciseness",
        criteria="Is the response under 20 words?",
        steps=["Count the words.", "Score 1.0 if under 20, else 0.0."],
    )
    llm = MockLLM({"conciseness": {"score": 1.0, "reason": "Only 4 words"}})
    input = JudgeInput(response="Yes I can help.")
    test_id = "test_custom"

    result = _run_in_test(test_id, lambda: judges.custom(custom_rubric, input, llm))

    state = pop_state(test_id)
    assert state is not None
    assert len(state.judgments) == 1
    assert state.judgments[0]["intent"] == "conciseness"
    assert result["verdict"] == "pass"


def test_json_fallback_extracts_embedded_json():
    """Tolerant parsing: JSON embedded in prose should still parse."""
    raw = 'Here is my evaluation: {"hallucination": {"score": 0.8, "reason": "ok"}} done.'
    llm = MockLLM(raw)
    input = JudgeInput(response="Test")
    test_id = "test_fallback_json"

    _run_in_test(test_id, lambda: judges.hallucination(input, llm))

    state = pop_state(test_id)
    assert state is not None
    assert len(state.judgments) == 1
    assert state.judgments[0]["verdict"] == "pass"
    assert state.judgments[0]["score"] == pytest.approx(0.8)
