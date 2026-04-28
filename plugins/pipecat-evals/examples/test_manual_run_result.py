from __future__ import annotations

import pytest

from pipecat_evals import (
    ChatMessage,
    ChatMessageEvent,
    FunctionCall,
    FunctionCallEvent,
    FunctionCallOutput,
    FunctionCallOutputEvent,
    RunResult,
)


def test_manual_order_lookup_transcript():
    result = RunResult(user_input="Where is order 123?")
    result.add_event(FunctionCallEvent(item=FunctionCall(
        name="lookup_order",
        arguments={"order_id": "123"},
        call_id="call-1",
    )))
    result.add_event(FunctionCallOutputEvent(item=FunctionCallOutput(
        output={"status": "shipped", "eta": "tomorrow"},
        call_id="call-1",
    )))
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="Order 123 has shipped and should arrive tomorrow.",
    )))

    result.expect.next_event().is_function_call(
        name="lookup_order",
        arguments={"order_id": "123"},
    )
    result.expect.next_event().is_function_call_output(call_id="call-1")
    result.expect.next_event().is_message(
        role="assistant",
        content_contains="shipped",
    )
    result.expect.no_more_events()


@pytest.mark.asyncio
async def test_manual_judge():
    result = RunResult(user_input="Can I get a refund?")
    result.add_event(ChatMessageEvent(item=ChatMessage(
        role="assistant",
        text_content="I can help start a refund request for your order.",
    )))

    class ContainsIntentJudge:
        def evaluate(self, *, message, intent):
            return {
                "success": "refund" in message.content.lower(),
                "reasoning": f"Checked intent: {intent}",
            }

    assertion = await result.expect.next_event().is_message().judge(
        ContainsIntentJudge(),
        intent="offers refund help",
    )

    assert assertion.judgment is not None
    assert assertion.judgment.success is True
    assert assertion.judgment.reasoning == "Checked intent: offers refund help"
