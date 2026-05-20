"""STT-quality judge for voice simulations and post-call reports."""

from __future__ import annotations

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.livekit.judges._instructions import STT_EVALUATION


def stt_evaluation_judge(*, transcript: str, llm: LLM | None = None) -> _LLMJudge:
    """Evaluate material speech-to-text errors from a voice transcript."""
    return _LLMJudge(
        llm=llm,
        name="stt",
        instructions=STT_EVALUATION.format(transcript=transcript or "(empty)"),
    )
