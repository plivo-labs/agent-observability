"""Goal-achievement judge ported from cx-sqs-worker goal evaluation."""

from __future__ import annotations

from typing import Iterable

from livekit.agents.llm import LLM

from agent_observability.livekit.goals import Goal
from agent_observability.livekit.judges._base import _LLMJudge
from agent_observability.livekit.judges._instructions import GOAL_EVALUATION


def _format_goals(goals: Iterable[Goal]) -> str:
    return "\n".join(f"- {goal.name}: {goal.description}" for goal in goals) or "(none)"


def goal_evaluation_judge(
    *,
    goals: Iterable[Goal],
    flow_history: str | None = None,
    llm: LLM | None = None,
) -> _LLMJudge:
    """Evaluate whether configured goals were achieved."""
    return _LLMJudge(
        llm=llm,
        name="goal_evaluation",
        instructions=GOAL_EVALUATION.format(
            goals=_format_goals(goals),
            flow_history=flow_history or "(use the conversation history)",
        ),
    )
