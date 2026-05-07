"""LLM-as-judge module for pytest-agent-observability.

Public API:
  judges.hallucination(input, llm, threshold=0.7)
  judges.adherence(input, llm, threshold=0.7)
  judges.evaluate(criteria, input, llm, threshold=0.7)  -- single combined LLM call
  judges.custom(rubric, input, llm, threshold=0.7)
  judges.Rubric, judges.JudgeInput, judges.LLMClient, judges.openai_adapter
"""

from __future__ import annotations

from typing import Any

from .adapters.openai import openai_adapter
from .rubrics import ADHERENCE_RUBRIC, HALLUCINATION_RUBRIC, Rubric
from .runner import evaluate as _evaluate
from .types import JudgeInput, LLMClient

__all__ = [
    "hallucination",
    "adherence",
    "evaluate",
    "custom",
    "Rubric",
    "JudgeInput",
    "LLMClient",
    "openai_adapter",
]

_RUBRIC_MAP: dict[str, Rubric] = {
    "hallucination": HALLUCINATION_RUBRIC,
    "adherence": ADHERENCE_RUBRIC,
}


def hallucination(
    input: JudgeInput,
    llm: LLMClient,
    threshold: float = 0.7,
) -> dict[str, Any]:
    """Run hallucination rubric only. Returns the judgment dict for that criterion."""
    result = _evaluate([HALLUCINATION_RUBRIC], input, llm, threshold)
    return result.get("hallucination", {})


def adherence(
    input: JudgeInput,
    llm: LLMClient,
    threshold: float = 0.7,
) -> dict[str, Any]:
    """Run adherence rubric only. Returns the judgment dict for that criterion."""
    result = _evaluate([ADHERENCE_RUBRIC], input, llm, threshold)
    return result.get("adherence", {})


def evaluate(
    input: JudgeInput,
    llm: LLMClient,
    criteria: list[str] | None = None,
    threshold: float = 0.7,
) -> dict[str, dict[str, Any]]:
    """Run one or more rubrics in a single LLM call.

    criteria defaults to ["hallucination", "adherence"].
    Unknown criterion names are ignored.
    """
    if criteria is None:
        criteria = ["hallucination", "adherence"]
    rubrics = [_RUBRIC_MAP[c] for c in criteria if c in _RUBRIC_MAP]
    return _evaluate(rubrics, input, llm, threshold)


def custom(
    rubric: Rubric,
    input: JudgeInput,
    llm: LLMClient,
    threshold: float = 0.7,
) -> dict[str, Any]:
    """Run a user-defined rubric. Returns the judgment dict for that criterion."""
    result = _evaluate([rubric], input, llm, threshold)
    return result.get(rubric.name, {})
