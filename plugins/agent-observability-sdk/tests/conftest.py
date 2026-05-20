"""Shared pytest fixtures for the agent-observability-sdk test suite."""

from __future__ import annotations

from typing import Iterable

import pytest
from livekit.agents.llm import ChatContext


@pytest.fixture
def empty_chat_ctx() -> ChatContext:
    """ChatContext with no messages — used for programmatic judges that
    derive everything from the conversation."""
    return ChatContext.empty()


@pytest.fixture
def chat_ctx_with_tools():
    """Factory that builds a ChatContext with the given function_call
    items, mirroring how an agent's chat history looks after a few tool
    invocations. Used by ToolCorrectnessJudge tests so we can exercise
    its auto-extraction from chat_ctx.items."""

    def _make(*tool_names: str) -> ChatContext:
        ctx = ChatContext.empty()
        for name in tool_names:
            ctx.items.append(
                _FakeFunctionCall(name=name, call_id=f"call_{name}", arguments="{}"),
            )
        return ctx

    return _make


class _FakeFunctionCall:
    """Minimal stand-in for a LiveKit function_call ChatItem.

    LiveKit's actual ChatItem types live in livekit.agents.llm.chat_context
    and have many fields the SDK doesn't care about. ToolCorrectnessJudge
    only reads `.type == 'function_call'` and `.name`, so we duck-type.
    """

    type = "function_call"

    def __init__(self, *, name: str, call_id: str, arguments: str) -> None:
        self.name = name
        self.call_id = call_id
        self.arguments = arguments


def _items_iter(names: Iterable[str]):
    """Helper for tests that want to enumerate without needing a fixture."""
    return [_FakeFunctionCall(name=n, call_id=f"c_{n}", arguments="{}") for n in names]
