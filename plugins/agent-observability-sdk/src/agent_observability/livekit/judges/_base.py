"""Internal plumbing shared by every LLM-judge factory in this package.

Two responsibilities:

1. **Single import seam for LiveKit's private ``_LLMJudge``.** The judge
   class lives at ``livekit.agents.evals.judge._LLMJudge`` — a private,
   underscore-prefixed symbol LiveKit makes no stability promise about.
   Every factory in this package re-imports it from *here* instead of
   reaching into LiveKit directly, so a future LiveKit rename is a
   one-line fix in this module rather than a sweep across ~6 files.

2. **Static-judge registry + factory.** Several judges run on a session
   in isolation — no ground truth, no ``.format()`` splicing — so their
   factories were near-identical
   ``return _LLMJudge(llm=llm, name="…", instructions=…)`` one-liners.
   They collapse to a single ``{name: INSTRUCTION}`` registry plus one
   :func:`static_judge` constructor; the public factory functions
   (``hallucination_judge`` etc.) stay as thin aliases so the public API,
   ``default_judges()``, and the per-judge docstrings are unchanged.

Ground-truth-bound judges (rigid response, variable extraction, KB
correctness) and the programmatic judges deliberately stay out of the
registry — they need caller-supplied values spliced into the prompt and
so keep their own bespoke factory bodies. They still import ``_LLMJudge``
from here for the seam in (1).
"""

from __future__ import annotations

# The one place in the SDK that touches LiveKit's private judge symbol.
from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.livekit.judges._instructions import (
    BOT_DETECTION,
    CALL_SCREENING,
    CONVERSATION_STATUS,
    DO_NOT_DISTURB,
    FREEFLOW_RESPONSE_ACCURACY,
    HALLUCINATION,
    HOLD_REQUESTED_INTENT_ACCURACY,
    LOOP_DETECTION,
    LOW_ENGAGEMENT,
    USER_SENTIMENT,
    VOICEMAIL_DETECTION,
    WRONG_NUMBER,
)

__all__ = ["_LLMJudge", "STATIC_JUDGE_INSTRUCTIONS", "static_judge"]


# name -> instruction body. A judge belongs here iff its instructions are
# a fixed string with no ground-truth substitution (see module docstring).
STATIC_JUDGE_INSTRUCTIONS: dict[str, str] = {
    "hallucination": HALLUCINATION,
    "freeflow_response_accuracy": FREEFLOW_RESPONSE_ACCURACY,
    "hold_requested_intent_accuracy": HOLD_REQUESTED_INTENT_ACCURACY,
    "loop_detection": LOOP_DETECTION,
    # Conversation-level classifiers (eval metrics). The
    # registry key is the judge's public ``name=`` — which differs from
    # the factory name for the voice classifiers (e.g. ``voicemail_detected``).
    "voicemail_detected": VOICEMAIL_DETECTION,
    "bot_detected": BOT_DETECTION,
    "call_screening": CALL_SCREENING,
    "low_engagement": LOW_ENGAGEMENT,
    "wrong_number": WRONG_NUMBER,
    "do_not_disturb": DO_NOT_DISTURB,
    "user_sentiment": USER_SENTIMENT,
    "conversation_status": CONVERSATION_STATUS,
}


def static_judge(name: str, llm: LLM | None = None) -> _LLMJudge:
    """Build a ground-truth-free LLM judge by registry ``name``.

    :param name: A key in :data:`STATIC_JUDGE_INSTRUCTIONS`.
    :param llm: Optional LLM passed straight through to ``_LLMJudge``;
        when ``None``, LiveKit resolves a default at evaluate time.
    :raises KeyError: If ``name`` is not a registered static judge.
    """
    try:
        instructions = STATIC_JUDGE_INSTRUCTIONS[name]
    except KeyError:
        raise KeyError(
            f"{name!r} is not a registered static judge. "
            f"Known: {sorted(STATIC_JUDGE_INSTRUCTIONS)}"
        ) from None
    return _LLMJudge(llm=llm, name=name, instructions=instructions)
