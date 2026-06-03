"""Variable-extraction judge.

Ported from cx-sqs-worker
`usecases/vibe_eval/evaluator/metrics/llm_metrics.go`
(`NewVariableExtractionMetric`) + `GetVariableExtractionPromptConfig`.

Needs ground truth: the set of variables the node SHOULD extract, plus the
mapping the agent ACTUALLY extracted. Both are baked into the instructions
at construction time.
"""

from __future__ import annotations

from typing import Iterable, Mapping

from livekit.agents.llm import LLM

from agent_observability.livekit.judges._base import _LLMJudge
from agent_observability.livekit.judges._instructions import VARIABLE_EXTRACTION


def variable_extraction_judge(
    *,
    expected_variables: Iterable[str],
    actual_variables: Mapping[str, str],
    llm: LLM | None = None,
) -> _LLMJudge:
    """Check whether `actual_variables` is a valid extraction:

    - every actual key must appear in `expected_variables` (no extras)
    - every actual value must be grounded in the conversation (no
      fabrications)
    - expected variables whose values WERE in context should have been
      extracted (no critical misses)
    """
    expected_list = "\n".join(f"- {name}" for name in expected_variables) or "(none)"
    if actual_variables:
        actual_list = "\n".join(
            f"- {name}: {value!r}" for name, value in actual_variables.items()
        )
    else:
        actual_list = "(none)"
    return _LLMJudge(
        llm=llm,
        name="variable_extraction",
        instructions=VARIABLE_EXTRACTION.format(
            expected_variables=expected_list,
            actual_variables=actual_list,
        ),
    )
