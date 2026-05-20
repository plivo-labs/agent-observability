"""Tests for the 9 LLM-based judge factories.

We don't actually call the LLM here — `_LLMJudge` is LiveKit code and is
covered by livekit-agents' own test suite. What we own is:

- the cx-sqs-worker criteria text that lives in `instructions`
- whether ground-truth args correctly splice into the template

So these tests verify:

1. each factory returns a Judge with the right `name`
2. the rendered `instructions` contains the cx-sqs-worker hallmark phrases
   (lifted verbatim from prompt/configs.go)
3. for parameterized factories, the ground-truth values appear in the
   final instructions string
"""

from __future__ import annotations

from agent_observability.judges import (
    freeflow_response_accuracy_judge,
    hallucination_judge,
    hold_requested_intent_accuracy_judge,
    knowledge_base_correctness_judge,
    loop_detection_judge,
    rigid_response_accuracy_judge,
    variable_extraction_judge,
)


# ── Ground-truth-free judges ───────────────────────────────────────────────


def test_hallucination_judge_metadata():
    j = hallucination_judge()
    assert j.name == "hallucination"
    assert "fabricated information" in j._instructions
    assert "factual accuracy" in j._instructions


def test_freeflow_response_accuracy_judge_metadata():
    j = freeflow_response_accuracy_judge()
    assert j.name == "freeflow_response_accuracy"
    assert "naturally continue the conversation" in j._instructions


def test_hold_requested_intent_accuracy_judge_metadata():
    j = hold_requested_intent_accuracy_judge()
    assert j.name == "hold_requested_intent_accuracy"
    assert "hold" in j._instructions.lower()
    assert "wait" in j._instructions.lower()


def test_loop_detection_judge_metadata():
    j = loop_detection_judge()
    assert j.name == "loop_detection"
    assert "repeat" in j._instructions.lower()
    assert "stuck" in j._instructions.lower()


# ── Ground-truth-bound judges ──────────────────────────────────────────────


def test_rigid_response_accuracy_splices_expected():
    j = rigid_response_accuracy_judge(
        expected_response="Thank you, your order was placed.",
    )
    assert j.name == "rigid_response_accuracy"
    assert "Thank you, your order was placed." in j._instructions
    assert "semantic meaning" in j._instructions


def test_variable_extraction_splices_variables():
    j = variable_extraction_judge(
        expected_variables=["customer_name", "order_id"],
        actual_variables={"customer_name": "Alice", "order_id": "X-42"},
    )
    assert j.name == "variable_extraction"
    assert "- customer_name" in j._instructions
    assert "- order_id" in j._instructions
    # Values appear, with repr quoting via {value!r}
    assert "'Alice'" in j._instructions
    assert "'X-42'" in j._instructions


def test_variable_extraction_empty_actual_renders_none():
    j = variable_extraction_judge(
        expected_variables=["customer_name"],
        actual_variables={},
    )
    assert "(none)" in j._instructions


def test_knowledge_base_correctness_splices_context():
    j = knowledge_base_correctness_judge(
        kb_context="The refund policy is 30 days from purchase.",
    )
    assert j.name == "knowledge_base_correctness"
    assert "30 days from purchase" in j._instructions


# ── default_judges() composition ───────────────────────────────────────────


def test_default_judges_returns_four_ground_truth_free_judges():
    from agent_observability.judges import default_judges

    judges = default_judges()
    names = [j.name for j in judges]
    assert names == [
        "hallucination",
        "freeflow_response_accuracy",
        "hold_requested_intent_accuracy",
        "loop_detection",
    ]


def test_default_judges_propagates_llm(monkeypatch):
    """When called with a LLM arg, every returned judge should carry it."""

    sentinel = object()

    from agent_observability.judges import default_judges

    judges = default_judges(llm=sentinel)  # type: ignore[arg-type]
    for j in judges:
        assert j._llm is sentinel
