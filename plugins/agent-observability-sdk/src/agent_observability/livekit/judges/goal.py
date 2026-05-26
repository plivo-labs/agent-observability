"""Goal-achievement judge ported from cx-sqs-worker goal evaluation."""

from __future__ import annotations

from typing import Iterable, Mapping, Any

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.livekit.judges._instructions import GOAL_EVALUATION


def _format_goals(goals: Iterable[str | Mapping[str, Any]]) -> str:
    out: list[str] = []
    for goal in goals:
        if isinstance(goal, Mapping):
            name = goal.get("goal_name") or goal.get("name") or goal.get("id")
            desc = goal.get("description") or goal.get("instructions")
            out.append(f"- {name}: {desc}" if desc else f"- {name}")
        else:
            out.append(f"- {goal}")
    return "\n".join(out) or "(none)"


def goal_evaluation_judge(
    *,
    goals: Iterable[str | Mapping[str, Any]],
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
