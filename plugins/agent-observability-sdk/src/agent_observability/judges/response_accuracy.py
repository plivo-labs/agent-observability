"""Response-accuracy judges (rigid / freeflow).

Ported from cx-sqs-worker
`usecases/vibe_eval/evaluator/metrics/llm_metrics.go`
(`NewRigidResponseAccuracyMetric`, `NewFreeflowResponseAccuracyMetric`) +
their `MetricPromptConfig` counterparts.

- `rigid_response_accuracy_judge` — compare against an expected response.
- `freeflow_response_accuracy_judge` — no ground truth, just contextual
  flow.

The semi-rigid variant from cx-sqs-worker is intentionally NOT ported —
its prompt is tightly coupled to cx-sqs-worker's flow-graph "node
instructions" model, which doesn't generalize beyond that runtime.
"""

from __future__ import annotations

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.judges._instructions import (
    FREEFLOW_RESPONSE_ACCURACY,
    RIGID_RESPONSE_ACCURACY,
)


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
    return _LLMJudge(
        llm=llm,
        name="freeflow_response_accuracy",
        instructions=FREEFLOW_RESPONSE_ACCURACY,
    )
