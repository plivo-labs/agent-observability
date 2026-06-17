"""Tests for the two programmatic judges (no LLM call)."""

from __future__ import annotations

import pytest

from agent_observability.livekit.judges import IntentAccuracyJudge, ToolCorrectnessJudge


# ── IntentAccuracyJudge ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_intent_accuracy_exact_match():
    judge = IntentAccuracyJudge(expected_intent="book_flight", actual_intent="book_flight")
    result = await judge.evaluate()
    assert result.verdict == "pass"
    assert "book_flight" in result.reasoning


@pytest.mark.asyncio
async def test_intent_accuracy_case_insensitive():
    judge = IntentAccuracyJudge(expected_intent="book_flight", actual_intent="Book_Flight")
    result = await judge.evaluate()
    assert result.verdict == "pass"


@pytest.mark.asyncio
async def test_intent_accuracy_whitespace_stripped():
    judge = IntentAccuracyJudge(expected_intent="  book_flight  ", actual_intent="book_flight")
    result = await judge.evaluate()
    assert result.verdict == "pass"


@pytest.mark.asyncio
async def test_intent_accuracy_mismatch():
    judge = IntentAccuracyJudge(expected_intent="book_flight", actual_intent="cancel")
    result = await judge.evaluate()
    assert result.verdict == "fail"
    assert "book_flight" in result.reasoning
    assert "cancel" in result.reasoning


@pytest.mark.asyncio
async def test_intent_accuracy_custom_name():
    judge = IntentAccuracyJudge(
        expected_intent="a", actual_intent="a", name="my_intent_judge"
    )
    assert judge.name == "my_intent_judge"


# ── ToolCorrectnessJudge ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tool_correctness_both_empty(empty_chat_ctx):
    judge = ToolCorrectnessJudge(expected_tools=[])
    result = await judge.evaluate(chat_ctx=empty_chat_ctx)
    assert result.verdict == "pass"
    assert "No tools" in result.reasoning


@pytest.mark.asyncio
async def test_tool_correctness_full_match(chat_ctx_with_tools):
    ctx = chat_ctx_with_tools("lookup_order", "send_email")
    judge = ToolCorrectnessJudge(expected_tools=["lookup_order", "send_email"])
    result = await judge.evaluate(chat_ctx=ctx)
    assert result.verdict == "pass"
    assert "2 matched" in result.reasoning


@pytest.mark.asyncio
async def test_tool_correctness_case_insensitive(chat_ctx_with_tools):
    ctx = chat_ctx_with_tools("Lookup_Order")
    judge = ToolCorrectnessJudge(expected_tools=["lookup_order"])
    result = await judge.evaluate(chat_ctx=ctx)
    assert result.verdict == "pass"


@pytest.mark.asyncio
async def test_tool_correctness_missing_tool(chat_ctx_with_tools):
    ctx = chat_ctx_with_tools("lookup_order")
    judge = ToolCorrectnessJudge(expected_tools=["lookup_order", "send_email"])
    result = await judge.evaluate(chat_ctx=ctx)
    # threshold=1.0 by default → half-match fails
    assert result.verdict == "fail"
    assert "Missing tools" in result.reasoning
    assert "send_email" in result.reasoning


@pytest.mark.asyncio
async def test_tool_correctness_unexpected_tool(chat_ctx_with_tools):
    ctx = chat_ctx_with_tools("lookup_order", "drop_database")
    judge = ToolCorrectnessJudge(expected_tools=["lookup_order"])
    result = await judge.evaluate(chat_ctx=ctx)
    # expected_count=1, matched=1 → score = 1.0 which passes threshold,
    # BUT the tool-score rule says: if expected_count > 0,
    # score = matched / expected. So this PASSES because we matched all
    # expected. Unexpected tools alone don't lower the score when
    # expected_count > 0.
    assert result.verdict == "pass"


@pytest.mark.asyncio
async def test_tool_correctness_unexpected_only(chat_ctx_with_tools):
    ctx = chat_ctx_with_tools("drop_database")
    judge = ToolCorrectnessJudge(expected_tools=[])
    result = await judge.evaluate(chat_ctx=ctx)
    # expected_count=0, unexpected>0 → score 0.0
    assert result.verdict == "fail"
    assert "Unexpected tools" in result.reasoning


@pytest.mark.asyncio
async def test_tool_correctness_partial_match_below_threshold(chat_ctx_with_tools):
    ctx = chat_ctx_with_tools("a")
    judge = ToolCorrectnessJudge(
        expected_tools=["a", "b", "c"], threshold=1.0
    )
    result = await judge.evaluate(chat_ctx=ctx)
    # 1/3 = 0.33 < 1.0
    assert result.verdict == "fail"


@pytest.mark.asyncio
async def test_tool_correctness_threshold_relaxed(chat_ctx_with_tools):
    ctx = chat_ctx_with_tools("a", "b")
    judge = ToolCorrectnessJudge(
        expected_tools=["a", "b", "c"], threshold=0.5
    )
    result = await judge.evaluate(chat_ctx=ctx)
    # 2/3 = 0.66 >= 0.5
    assert result.verdict == "pass"
