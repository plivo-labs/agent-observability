"""Tests for the LLM-based judge factories.

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

from agent_observability.livekit.judges import (
    bot_detection_judge,
    call_screening_judge,
    conversation_judges,
    conversation_status_judge,
    do_not_disturb_judge,
    freeflow_response_accuracy_judge,
    goal_evaluation_judge,
    hallucination_judge,
    hold_requested_intent_accuracy_judge,
    instruction_adherence_judge,
    intent_identification_judge,
    knowledge_base_correctness_judge,
    low_engagement_judge,
    loop_detection_judge,
    rigid_response_accuracy_judge,
    stt_evaluation_judge,
    turn_detection_judge,
    user_sentiment_judge,
    variable_extraction_judge,
    voicemail_detection_judge,
    wrong_number_judge,
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


def test_conversation_classifier_judge_metadata():
    cases = [
        (voicemail_detection_judge(), "voicemail_detected", "voicemail"),
        (bot_detection_judge(), "bot_detected", "ivr"),
        (call_screening_judge(), "call_screening", "screening"),
        (low_engagement_judge(), "low_engagement", "minimal"),
        (wrong_number_judge(), "wrong_number", "intended recipient"),
        (do_not_disturb_judge(), "do_not_disturb", "contacted again"),
        (user_sentiment_judge(), "user_sentiment", "positive"),
        (conversation_status_judge(), "conversation_status", "human_contact"),
    ]
    for judge, name, phrase in cases:
        assert judge.name == name
        assert phrase in judge._instructions.lower()


def test_conversation_judges_voice_and_text_sets():
    voice_names = [j.name for j in conversation_judges(voice=True)]
    text_names = [j.name for j in conversation_judges(voice=False)]

    assert voice_names == [
        "voicemail_detected",
        "bot_detected",
        "call_screening",
        "low_engagement",
        "wrong_number",
        "do_not_disturb",
        "user_sentiment",
        "conversation_status",
    ]
    assert text_names == [
        "low_engagement",
        "wrong_number",
        "do_not_disturb",
        "user_sentiment",
        "conversation_status",
    ]


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


def test_instruction_adherence_splices_context():
    j = instruction_adherence_judge(
        instructions="Confirm address before placing an order.",
        objective="Place an eligible order only after confirmation.",
    )
    assert j.name == "instruction_adherence"
    assert "Confirm address" in j._instructions
    assert "objective_progress" in j._instructions
    assert "policy_boundary_compliance" in j._instructions


def test_intent_identification_splices_available_intents():
    j = intent_identification_judge(
        available_intents=[
            {"intent_name": "cancel_order", "intent_instructions": "Cancel an order"},
            "track_order",
        ],
        chosen_intent="cancel_order",
    )
    assert j.name == "intent_identification"
    assert "cancel_order" in j._instructions
    assert "intent_not_found" in j._instructions


def test_goal_evaluation_splices_goals():
    j = goal_evaluation_judge(
        goals=[{"goal_name": "collect_email", "description": "Get user email"}],
        flow_history="User provided maya@example.com",
    )
    assert j.name == "goal_evaluation"
    assert "collect_email" in j._instructions
    assert "maya@example.com" in j._instructions


def test_stt_evaluation_splices_transcript():
    j = stt_evaluation_judge(transcript="User: I said Austin, not Boston")
    assert j.name == "stt"
    assert "Austin" in j._instructions
    assert "speech-to-text" in j._instructions


def test_turn_detection_splices_fragments():
    j = turn_detection_judge(
        fragments=[
            {"transcribed_text": "I want to", "is_eou": True},
            "book a meeting tomorrow",
        ],
    )
    assert j.name == "turn_detection"
    assert "I want to" in j._instructions
    assert "premature" in j._instructions.lower()


# ── default_judges() composition ───────────────────────────────────────────


def test_default_judges_returns_four_ground_truth_free_judges():
    from agent_observability.livekit.judges import default_judges

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

    from agent_observability.livekit.judges import default_judges

    judges = default_judges(llm=sentinel)  # type: ignore[arg-type]
    for j in judges:
        assert j._llm is sentinel
