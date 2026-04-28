from __future__ import annotations

from types import SimpleNamespace

import pytest

from pipecat_evals import (
    AgentHandoff,
    AgentHandoffEvent,
    ChatMessage,
    ChatMessageEvent,
    FunctionCall,
    FunctionCallEvent,
    FunctionCallOutput,
    FunctionCallOutputEvent,
    JudgeResult,
    OpenAIJudge,
    RunResult,
)
from pipecat_evals.hooks import register_judgment_hook


def test_run_result_expectations_match_livekit_style():
    result = RunResult(user_input="hello")
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="Hello, how can I help?",
    )))
    result.add_event(FunctionCallEvent(item=FunctionCall(
        name="lookup_order",
        arguments={"id": "123"},
        call_id="call-1",
    )))
    result.add_event(FunctionCallOutputEvent(item=FunctionCallOutput(
        output={"status": "shipped"},
        call_id="call-1",
    )))

    result.expect.next_event().is_message(role="assistant", content_contains="help")
    result.expect.next_event().is_function_call(
        name="lookup_order",
        arguments={"id": "123"},
    )
    result.expect.next_event().is_function_call_output(call_id="call-1", is_error=False)
    result.expect.no_more_events()


def test_run_assertion_helpers_cover_cursor_and_failure_paths():
    result = RunResult(user_input="hello")
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="Hello, how can I help?",
    )))
    result.add_event(FunctionCallEvent(item=FunctionCall(name="lookup_order")))
    result.add_event(AgentHandoffEvent(item=AgentHandoff(
        from_agent="triage",
        to_agent="support",
    )))

    result.expect.skip_next_event_if(lambda event: event.type == "message")
    result.expect.next_event(type="function_call").matches(name="lookup_order")
    result.expect.next_event().is_agent_handoff(from_agent="triage", to_agent="support")
    result.expect.no_more_events()

    with pytest.raises(AssertionError, match="no matching event"):
        result.expect.next_event()
    with pytest.raises(AssertionError, match="matching message"):
        result.expect.contains_message(content_contains="missing")
    with pytest.raises(AssertionError, match="matching function_call"):
        result.expect.contains_function_call(name="missing")
    with pytest.raises(AssertionError, match="matching function_call_output"):
        result.expect.contains_function_call_output(call_id="missing")

    result_with_remaining_event = RunResult()
    result_with_remaining_event.add_event(ChatMessageEvent(
        item=ChatMessage(role="assistant", text_content="hi"),
    ))
    with pytest.raises(AssertionError, match="no more events"):
        result_with_remaining_event.expect.no_more_events()


def test_livekit_style_indexing_ranges_and_typed_skips():
    result = RunResult(user_input="hello")
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="Hello, how can I help?",
    )))
    result.add_event(FunctionCallEvent(item=FunctionCall(
        name="lookup_order",
        arguments={"id": "123", "include_eta": True},
        call_id="call-1",
    )))
    result.add_event(FunctionCallOutputEvent(item=FunctionCallOutput(
        output="shipped",
        call_id="call-1",
    )))

    result.expect[0].is_message(role="assistant")
    result.expect[1:3].contains_function_call(
        name="lookup_order",
        arguments={"id": "123"},
    )
    result.expect[1:].contains_function_call_output(output="shipped")

    typed = result.expect.next_event(type="message")
    assert typed.message.text_content.startswith("Hello")
    skipped = result.expect.skip_next_event_if(
        type="function_call",
        name="lookup_order",
        arguments={"id": "123"},
    )
    assert skipped is not None
    assert result.expect.skip_next_event_if(type="message") is None
    result.expect.next_event(type="function_call_output").matches(output="shipped")
    result.expect.no_more_events()


def test_event_assertions_report_mismatches():
    message = ChatMessageEvent(item=ChatMessage(role="assistant", text_content="hello"))
    call = FunctionCallEvent(item=FunctionCall(name="lookup", arguments={"id": "1"}))
    output = FunctionCallOutputEvent(item=FunctionCallOutput(
        output="ok",
        call_id="call-1",
        is_error=True,
    ))
    handoff = AgentHandoffEvent(item=AgentHandoff(from_agent="a", to_agent="b"))

    result = RunResult()
    result.add_event(message)
    with pytest.raises(AssertionError, match="event type"):
        result.expect.next_event().has_type("function_call")

    result = RunResult()
    result.add_event(message)
    with pytest.raises(AssertionError, match="message role"):
        result.expect.next_event().is_message(role="user")

    result = RunResult()
    result.add_event(message)
    with pytest.raises(AssertionError, match="message content"):
        result.expect.next_event().is_message(content="goodbye")

    result = RunResult()
    result.add_event(message)
    with pytest.raises(AssertionError, match="to match"):
        result.expect.next_event().is_message(pattern="goodbye")

    result = RunResult()
    result.add_event(call)
    with pytest.raises(AssertionError, match="For key"):
        result.expect.next_event().is_function_call(arguments={"id": "2"})

    result = RunResult()
    result.add_event(output)
    with pytest.raises(AssertionError, match="is_error"):
        result.expect.next_event().is_function_call_output(is_error=False)

    result = RunResult()
    result.add_event(handoff)
    with pytest.raises(AssertionError, match="to_agent"):
        result.expect.next_event().is_agent_handoff(to_agent="c")


@pytest.mark.asyncio
async def test_judge_normalizes_pass_and_fail_results():
    result = RunResult(user_input="hello")
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="Hello there",
    )))

    assertion = result.expect.next_event().is_message()
    passed = await assertion.judge(
        lambda text, intent: {"success": "hello" in text.lower(), "reasoning": intent},
        intent="greets",
    )
    assert passed is assertion
    assert assertion.judgment == JudgeResult(success=True, reasoning="greets", raw={
        "success": True,
        "reasoning": "greets",
    })

    with pytest.raises(AssertionError, match="Judgement failed"):
        await assertion.judge(lambda *_args, **_kwargs: (False, "too terse"), intent="warm")


@pytest.mark.asyncio
async def test_judge_emits_first_class_observer_hook():
    observed = []
    unregister = register_judgment_hook(lambda intent, judgment: observed.append((
        intent,
        judgment.verdict,
        judgment.reasoning,
    )))
    try:
        result = RunResult(user_input="hello")
        result.add_event(ChatMessageEvent(item=ChatMessage(
            role="assistant",
            text_content="Hello there",
        )))

        await result.expect.next_event().is_message().judge(
            lambda *_args, **_kwargs: (True, "good"),
            intent="greets",
        )
    finally:
        unregister()

    assert observed == [("greets", "pass", "good")]


@pytest.mark.asyncio
async def test_judge_accepts_object_methods_and_verdict_shapes():
    result = RunResult(user_input="hello")
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="Hello there",
    )))
    assertion = result.expect.next_event().is_message()

    class EvaluateJudge:
        async def evaluate(self, *, message, intent):
            return JudgeResult(success=message.content == "Hello there", reasoning=intent)

    class VerdictJudge:
        def check(self, text, intent):
            return {"verdict": "pass", "reasoning": f"{intent}: {text}"}

    passed = await assertion.judge(EvaluateJudge(), intent="matches")
    assert passed is assertion
    assert assertion.judgment is not None
    assert assertion.judgment.success is True
    assert assertion.judgment.reasoning == "matches"

    passed = await assertion.judge(VerdictJudge(), intent="verdict shape")
    assert passed is assertion
    assert assertion.judgment is not None
    assert assertion.judgment.success is True
    assert "verdict shape" in assertion.judgment.reasoning

    with pytest.raises(AssertionError, match="Judgement failed"):
        await assertion.judge(lambda *_args, **_kwargs: {"success": "false"}, intent="bad")

    with pytest.raises(TypeError, match="judge is required"):
        await assertion.judge(intent="missing")

    with pytest.raises(TypeError, match="judge must be callable"):
        await assertion.judge(object(), intent="not callable")


@pytest.mark.asyncio
async def test_message_assertion_accepts_openai_judge_object():
    result = RunResult(user_input="hello")
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="Hello there",
    )))

    class FakeCompletions:
        @staticmethod
        async def create(**_kwargs):
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=(
                            '{"success": true, "reasoning": "LLM judged the greeting", '
                            '"score": null}'
                        )),
                    )
                ],
            )

    class FakeClient:
        chat = SimpleNamespace(completions=FakeCompletions())

    assertion = await result.expect.next_event().is_message().judge(
        OpenAIJudge(client=FakeClient()),
        intent="greets",
    )

    assert assertion.judgment is not None
    assert assertion.judgment.success is True
    assert assertion.judgment.reasoning == "LLM judged the greeting"


@pytest.mark.asyncio
async def test_run_result_timeout():
    result = RunResult(user_input="slow")
    with pytest.raises(TimeoutError, match="timed out"):
        await result.wait(timeout_s=0.001)


@pytest.mark.asyncio
async def test_run_result_completion_and_exception_propagation():
    result = RunResult(user_input="ok")
    result._mark_done()
    assert await result.wait(timeout_s=0.001) is result

    failed = RunResult(user_input="boom")
    failed._set_exception(RuntimeError("pipeline failed"))
    with pytest.raises(RuntimeError, match="pipeline failed"):
        await failed.wait(timeout_s=0.001)
