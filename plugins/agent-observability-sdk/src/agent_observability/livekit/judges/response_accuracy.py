"""Response-accuracy judges (rigid / freeflow).

- `rigid_response_accuracy_judge` — compare against an expected response.
- `freeflow_response_accuracy_judge` — no ground truth, just contextual
  flow.

A semi-rigid variant is intentionally not provided — its prompt assumes a
closed, predeclared set of per-turn expected responses that doesn't
generalize to open conversations.
"""

from __future__ import annotations

from livekit.agents.llm import LLM

from agent_observability.livekit.judges._base import _LLMJudge, static_judge
from agent_observability.livekit.judges._instructions import RIGID_RESPONSE_ACCURACY


def rigid_response_accuracy_judge(
    *,
    expected_response: str,
    llm: LLM | None = None,
) -> _LLMJudge:
    """Compare the agent's latest message against `expected_response`
    semantically. Rephrasing / synonyms are allowed; missing key info or a
    different topic fails.
    """
    return _LLMJudge(
        llm=llm,
        name="rigid_response_accuracy",
        instructions=RIGID_RESPONSE_ACCURACY.format(
            expected_response=expected_response,
        ),
    )


def freeflow_response_accuracy_judge(llm: LLM | None = None) -> _LLMJudge:
    """No ground truth — pass if the agent's response is contextually
    connected to the conversation (acknowledges history, stays on topic),
    fail if it ignores history or repeats answered questions.
    """
    return static_judge("freeflow_response_accuracy", llm=llm)
