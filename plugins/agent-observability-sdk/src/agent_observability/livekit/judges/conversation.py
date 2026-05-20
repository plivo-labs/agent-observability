"""Conversation-level judges ported from cx-sqs-worker eval metrics."""

from __future__ import annotations

from livekit.agents.evals.judge import _LLMJudge
from livekit.agents.llm import LLM

from agent_observability.livekit.judges._instructions import (
    BOT_DETECTION,
    CALL_SCREENING,
    CONVERSATION_STATUS,
    DO_NOT_DISTURB,
    LOW_ENGAGEMENT,
    USER_SENTIMENT,
    VOICEMAIL_DETECTION,
    WRONG_NUMBER,
)


def voicemail_detection_judge(llm: LLM | None = None) -> _LLMJudge:
    """Voice judge: detect direct voicemail, excluding screening and IVR."""
    return _LLMJudge(llm=llm, name="voicemail_detected", instructions=VOICEMAIL_DETECTION)


def bot_detection_judge(llm: LLM | None = None) -> _LLMJudge:
    """Voice judge: detect IVR / automated bot answer."""
    return _LLMJudge(llm=llm, name="bot_detected", instructions=BOT_DETECTION)


def call_screening_judge(llm: LLM | None = None) -> _LLMJudge:
    """Voice judge: detect unresolved iOS / Android / Google call screening."""
    return _LLMJudge(llm=llm, name="call_screening", instructions=CALL_SCREENING)


def low_engagement_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect a human who answered but never engaged beyond brief acknowledgements."""
    return _LLMJudge(llm=llm, name="low_engagement", instructions=LOW_ENGAGEMENT)


def wrong_number_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect wrong-number / wrong-recipient conversations."""
    return _LLMJudge(llm=llm, name="wrong_number", instructions=WRONG_NUMBER)


def do_not_disturb_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect explicit requests to stop future contact."""
    return _LLMJudge(llm=llm, name="do_not_disturb", instructions=DO_NOT_DISTURB)


def user_sentiment_judge(llm: LLM | None = None) -> _LLMJudge:
    """Classify user sentiment and fail on materially negative / confused experience."""
    return _LLMJudge(llm=llm, name="user_sentiment", instructions=USER_SENTIMENT)


def conversation_status_judge(llm: LLM | None = None) -> _LLMJudge:
    """Derive the final conversation status using cx-sqs-worker's priority order."""
    return _LLMJudge(llm=llm, name="conversation_status", instructions=CONVERSATION_STATUS)


def conversation_judges(*, voice: bool = True, llm: LLM | None = None) -> list[_LLMJudge]:
    """Return the cx-style conversation-level judge set.

    Voice adds voicemail / bot / call-screening classifiers. The cross-channel
    judges also apply to text, SMS, and WhatsApp style conversations.
    """
    judges: list[_LLMJudge] = []
    if voice:
        judges.extend([
            voicemail_detection_judge(llm=llm),
            bot_detection_judge(llm=llm),
            call_screening_judge(llm=llm),
        ])
    judges.extend([
        low_engagement_judge(llm=llm),
        wrong_number_judge(llm=llm),
        do_not_disturb_judge(llm=llm),
        user_sentiment_judge(llm=llm),
        conversation_status_judge(llm=llm),
    ])
    return judges
