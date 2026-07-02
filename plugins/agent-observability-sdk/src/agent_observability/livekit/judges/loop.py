"""Loop-detection judge.

Runs on a session in isolation — no ground truth required. Reads the
conversation history and flags unjustified repetition of the agent's own
recent messages.
"""

from __future__ import annotations

from livekit.agents.llm import LLM

from agent_observability.livekit.judges._base import _LLMJudge, static_judge


def loop_detection_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect whether the agent is stuck repeating its own recent messages."""
    return static_judge("loop_detection", llm=llm)
