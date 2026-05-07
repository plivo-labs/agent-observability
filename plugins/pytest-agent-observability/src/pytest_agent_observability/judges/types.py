"""Shared types for the judges package."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


@dataclass
class JudgeInput:
    response: str
    context: str | list[str] | None = None
    system_prompt: str | None = None
    task_instructions: str | None = None
    conversation_history: list[dict[str, Any]] | None = None


@runtime_checkable
class LLMClient(Protocol):
    def evaluate(self, prompt: str) -> str:
        ...
