"""Evaluation judges ported from cx-sqs-worker's vibe_eval metrics.

Every judge in this package is a LiveKit-compatible `Judge`: it has a
`name` property and an async `evaluate(*, chat_ctx, reference=None,
llm=None) -> JudgmentResult` method. That means anything in here drops
straight into a `livekit.agents.evals.JudgeGroup` alongside LiveKit's
built-ins (`accuracy_judge`, `safety_judge`, …).

Two flavors of judge:

- **LLM judges** — factory functions returning `Judge(...)`. They wrap
  cx-sqs-worker's criteria/steps as the judge's `instructions`, and
  LiveKit's runtime handles the `submit_verdict` tool-call dance.
- **Programmatic judges** — `IntentAccuracyJudge`, `ToolCorrectnessJudge`.
  Plain Python comparisons, no LLM. They still satisfy the LiveKit Judge
  protocol so users compose them uniformly.

The `default_judges()` helper returns instances of every judge that runs
*without ground truth*, suitable for spread composition with custom
judges.
"""

from __future__ import annotations

from livekit.agents.evals import Judge, JudgmentResult, Verdict
from livekit.agents.llm import LLM

# LLM judges — factory functions
from agent_observability.livekit.judges.hallucination import hallucination_judge
from agent_observability.livekit.judges.intent import hold_requested_intent_accuracy_judge
from agent_observability.livekit.judges.knowledge_base import (
    knowledge_base_correctness_judge,
)
from agent_observability.livekit.judges.loop import loop_detection_judge
from agent_observability.livekit.judges.response_accuracy import (
    freeflow_response_accuracy_judge,
    rigid_response_accuracy_judge,
)
from agent_observability.livekit.judges.variable import variable_extraction_judge

# Programmatic judges — classes
from agent_observability.livekit.judges.intent import IntentAccuracyJudge
from agent_observability.livekit.judges.tool import ToolCorrectnessJudge


def default_judges(llm: LLM | None = None) -> list[Judge]:
    """Return the SDK's pre-configured ground-truth-free judges.

    A judge ships in this list iff it can evaluate a session in isolation
    — no expected response, no available-intents list, no KB context. The
    four current defaults are Hallucination, Freeflow Response Accuracy,
    Hold-Requested Intent Accuracy, and Loop Detection.

    Compose with your own ground-truth-bound judges via spread:

        judges = [
            IntentAccuracyJudge(
                expected_intent="book_flight",
                actual_intent=detected,
            ),
            *default_judges(llm=my_llm),
        ]

    Judges that require ground truth (rigid response accuracy, variable
    extraction, KB correctness, intent accuracy, tool correctness) are
    excluded — only the caller knows the expected values, so they have to
    be constructed by hand.
    """
    return [
        hallucination_judge(llm=llm),
        freeflow_response_accuracy_judge(llm=llm),
        hold_requested_intent_accuracy_judge(llm=llm),
        loop_detection_judge(llm=llm),
    ]


__all__ = [
    # Re-exported LiveKit types
    "Judge",
    "JudgmentResult",
    "Verdict",
    # LLM judge factories
    "hallucination_judge",
    "rigid_response_accuracy_judge",
    "freeflow_response_accuracy_judge",
    "hold_requested_intent_accuracy_judge",
    "variable_extraction_judge",
    "loop_detection_judge",
    "knowledge_base_correctness_judge",
    # Programmatic judges
    "IntentAccuracyJudge",
    "ToolCorrectnessJudge",
    # Composition helper
    "default_judges",
]
