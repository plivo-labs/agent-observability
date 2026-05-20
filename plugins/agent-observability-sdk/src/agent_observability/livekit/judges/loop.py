"""Loop-detection judge.

Ported from cx-sqs-worker
`usecases/vibe_eval/evaluator/metrics/llm_metrics.go`
(`NewLoopDetectionMetric`) + `GetLoopDetectionPromptConfig`.

Runs on a session in isolation — no ground truth required. Reads the
conversation history and flags unjustified repetition of the agent's own
recent messages.
"""

from __future__ import annotations

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.livekit.judges._instructions import LOOP_DETECTION


def loop_detection_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect whether the agent is stuck repeating its own recent messages."""
    return _LLMJudge(llm=llm, name="loop_detection", instructions=LOOP_DETECTION)
