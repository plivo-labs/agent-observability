"""Instruction and intent-identification judges with cx-style rubrics."""

from __future__ import annotations

from typing import Iterable, Mapping, Any

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.livekit.judges._instructions import (
    INSTRUCTION_ADHERENCE,
    INTENT_IDENTIFICATION,
)


def _format_list(values: Iterable[Any]) -> str:
    items = [str(v) for v in values if str(v).strip()]
    return "\n".join(f"- {item}" for item in items) or "(none)"


def instruction_adherence_judge(
    *,
    instructions: str,
    objective: str | None = None,
    llm: LLM | None = None,
) -> _LLMJudge:
    """Evaluate cx-style instruction adherence.

    The rubric covers objective progress, procedure compliance, interaction
    quality, and policy-boundary compliance.
    """
    return _LLMJudge(
        llm=llm,
        name="instruction_adherence",
        instructions=INSTRUCTION_ADHERENCE.format(
            instructions=instructions or "(none)",
            objective=objective or "(none)",
        ),
    )


def intent_identification_judge(
    *,
    available_intents: Iterable[str | Mapping[str, Any]],
    chosen_intent: str | None,
    llm: LLM | None = None,
) -> _LLMJudge:
    """Evaluate cx-style intent identification against available intents."""
    formatted_intents: list[str] = []
    for intent in available_intents:
        if isinstance(intent, Mapping):
            name = intent.get("intent_name") or intent.get("name") or intent.get("id")
            desc = intent.get("intent_instructions") or intent.get("description")
            formatted_intents.append(f"{name}: {desc}" if desc else str(name))
        else:
            formatted_intents.append(str(intent))

    return _LLMJudge(
        llm=llm,
        name="intent_identification",
        instructions=INTENT_IDENTIFICATION.format(
            available_intents=_format_list(formatted_intents),
            chosen_intent=chosen_intent or "(none)",
        ),
    )
