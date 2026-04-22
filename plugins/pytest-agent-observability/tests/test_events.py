from __future__ import annotations

from dataclasses import dataclass

from pytest_agent_observability.events import serialize_events


# ── Fake LiveKit event shapes ──────────────────────────────────────────────

@dataclass
class FakeChatMsg:
    role: str
    text_content: str
    interrupted: bool = False


@dataclass
class FakeFnCall:
    name: str
    arguments: str
    call_id: str = "c1"


@dataclass
class FakeFnOutput:
    output: str
    is_error: bool = False
    call_id: str = "c1"


@dataclass
class FakeAgentA: ...


@dataclass
class FakeAgentB: ...


@dataclass
class MessageEvent:
    item: FakeChatMsg
    type: str = "message"


@dataclass
class FunctionCallEvent:
    item: FakeFnCall
    type: str = "function_call"


@dataclass
class FunctionCallOutputEvent:
    item: FakeFnOutput
    type: str = "function_call_output"


@dataclass
class AgentHandoffEvent:
    item: object
    old_agent: object
    new_agent: object
    type: str = "agent_handoff"


# ── Tests ──────────────────────────────────────────────────────────────────

def test_empty_input_returns_empty_list():
    assert serialize_events(None) == []
    assert serialize_events([]) == []


def test_message_event():
    ev = MessageEvent(item=FakeChatMsg(role="assistant", text_content="hi"))
    out = serialize_events([ev])
    assert len(out) == 1
    # Convenience top-level fields for existing UI consumers.
    assert out[0]["type"] == "message"
    assert out[0]["role"] == "assistant"
    assert out[0]["content"] == "hi"
    assert out[0]["interrupted"] is False
    # Full item is preserved under `item` — no fields stripped.
    assert out[0]["item"]["role"] == "assistant"
    assert out[0]["item"]["text_content"] == "hi"


def test_message_event_preserves_metrics():
    """LiveKit attaches per-turn metrics (ttft, timings) to ChatMessage.metrics.
    The serializer must forward it both on `item.metrics` and at the top level."""

    @dataclass
    class ChatMsgWithMetrics:
        role: str
        text_content: str
        interrupted: bool = False
        metrics: dict = None  # type: ignore[assignment]

    ev = MessageEvent(
        item=ChatMsgWithMetrics(
            role="assistant",
            text_content="hi",
            metrics={
                "started_speaking_at": 1776850284.14,
                "stopped_speaking_at": 1776850284.30,
                "llm_node_ttft": 1.206,
            },
        )
    )
    out = serialize_events([ev])
    assert out[0]["metrics"]["llm_node_ttft"] == 1.206
    assert out[0]["item"]["metrics"]["started_speaking_at"] == 1776850284.14


def test_function_call_parses_json_arguments():
    ev = FunctionCallEvent(item=FakeFnCall(name="lookup_order", arguments='{"order_id": "12345"}'))
    out = serialize_events([ev])
    assert len(out) == 1
    assert out[0]["type"] == "function_call"
    assert out[0]["name"] == "lookup_order"
    assert out[0]["arguments"] == {"order_id": "12345"}


def test_function_call_keeps_non_json_arguments_as_string():
    ev = FunctionCallEvent(item=FakeFnCall(name="x", arguments="not-json"))
    out = serialize_events([ev])
    assert out[0]["arguments"] == "not-json"


def test_function_call_output():
    ev = FunctionCallOutputEvent(item=FakeFnOutput(output="ok", is_error=False))
    out = serialize_events([ev])
    assert out[0]["type"] == "function_call_output"
    assert out[0]["output"] == "ok"
    assert out[0]["is_error"] is False
    assert out[0]["call_id"] == "c1"


def test_agent_handoff_uses_class_names():
    ev = AgentHandoffEvent(item=object(), old_agent=FakeAgentA(), new_agent=FakeAgentB())
    out = serialize_events([ev])
    assert out[0]["type"] == "agent_handoff"
    assert out[0]["from_agent"] == "FakeAgentA"
    assert out[0]["to_agent"] == "FakeAgentB"


def test_unknown_event_type_is_passed_through():
    """Unknown event kinds should land in the payload as-is so the dashboard
    can inspect their shape — no silent drops."""

    @dataclass
    class Weird:
        type: str = "zzz"
        meta: str = "hello"

    out = serialize_events([Weird()])
    assert len(out) == 1
    assert out[0]["type"] == "zzz"
    assert out[0]["meta"] == "hello"


def test_no_event_count_cap():
    """Previously capped at 500; now all events survive."""
    events = [MessageEvent(item=FakeChatMsg(role="user", text_content=f"m{i}"))
              for i in range(800)]
    out = serialize_events(events)
    assert len(out) == 800


def test_long_content_preserved():
    """Previously truncated at 10_000 chars; now preserved verbatim."""
    long_content = "x" * 20_000
    ev = MessageEvent(item=FakeChatMsg(role="assistant", text_content=long_content))
    out = serialize_events([ev])
    assert out[0]["content"] == long_content
