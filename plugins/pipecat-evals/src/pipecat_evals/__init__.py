"""LiveKit-style pytest eval helpers for Pipecat text agents."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

from .judges import LLMJudge, OpenAIJudge
from .run_result import (
    AgentHandoff,
    AgentHandoffAssert,
    AgentHandoffEvent,
    ChatMessage,
    ChatMessageAssert,
    ChatMessageEvent,
    EventAssert,
    EventRangeAssert,
    FunctionCall,
    FunctionCallAssert,
    FunctionCallEvent,
    FunctionCallOutput,
    FunctionCallOutputAssert,
    FunctionCallOutputEvent,
    JudgeResult,
    RunAssert,
    RunResult,
)
from .session import AgentSession
from .tools import mock_tools

try:
    __version__ = version("pipecat-evals")
except PackageNotFoundError:  # pragma: no cover - editable source tree
    __version__ = "0.0.0"

__all__ = [
    "AgentHandoff",
    "AgentHandoffAssert",
    "AgentHandoffEvent",
    "AgentSession",
    "ChatMessage",
    "ChatMessageAssert",
    "ChatMessageEvent",
    "EventAssert",
    "EventRangeAssert",
    "FunctionCall",
    "FunctionCallAssert",
    "FunctionCallEvent",
    "FunctionCallOutput",
    "FunctionCallOutputAssert",
    "FunctionCallOutputEvent",
    "JudgeResult",
    "LLMJudge",
    "OpenAIJudge",
    "RunAssert",
    "RunResult",
    "__version__",
    "mock_tools",
]
