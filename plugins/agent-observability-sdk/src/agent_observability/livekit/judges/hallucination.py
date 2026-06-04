"""Hallucination judge.

Ported from cx-sqs-worker `usecases/vibe_eval/evaluator/metrics/llm_metrics.go`
(`NewHallucinationMetric`) + `prompt/configs.go` (`GetHallucinationPromptConfig`).

Runs on a session in isolation — no ground truth required.
"""

from __future__ import annotations

from livekit.agents.llm import LLM

from agent_observability.livekit.judges._base import _LLMJudge, static_judge


def hallucination_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect fabricated information in agent responses.

    Pass if every factual claim is grounded in the conversation, function
    call outputs, or the agent's instructions; fail if any critical fact
    is fabricated. Style and formatting differences are NOT failures.
    """
    return static_judge("hallucination", llm=llm)
