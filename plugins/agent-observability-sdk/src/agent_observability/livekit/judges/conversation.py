"""Conversation-level judges ported from cx-sqs-worker eval metrics."""

from __future__ import annotations

from livekit.agents.llm import LLM

from agent_observability.livekit.judges._base import _LLMJudge, static_judge


def voicemail_detection_judge(llm: LLM | None = None) -> _LLMJudge:
    """Voice judge: detect direct voicemail, excluding screening and IVR."""
    return static_judge("voicemail_detected", llm=llm)


def bot_detection_judge(llm: LLM | None = None) -> _LLMJudge:
    """Voice judge: detect IVR / automated bot answer."""
    return static_judge("bot_detected", llm=llm)


def call_screening_judge(llm: LLM | None = None) -> _LLMJudge:
    """Voice judge: detect unresolved iOS / Android / Google call screening."""
    return static_judge("call_screening", llm=llm)


def low_engagement_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect a human who answered but never engaged beyond brief acknowledgements."""
    return static_judge("low_engagement", llm=llm)


def wrong_number_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect wrong-number / wrong-recipient conversations."""
    return static_judge("wrong_number", llm=llm)


def do_not_disturb_judge(llm: LLM | None = None) -> _LLMJudge:
    """Detect explicit requests to stop future contact."""
    return static_judge("do_not_disturb", llm=llm)


def user_sentiment_judge(llm: LLM | None = None) -> _LLMJudge:
    """Classify user sentiment and fail on materially negative / confused experience."""
    return static_judge("user_sentiment", llm=llm)


def conversation_status_judge(llm: LLM | None = None) -> _LLMJudge:
    """Derive the final conversation status using cx-sqs-worker's priority order."""
    return static_judge("conversation_status", llm=llm)


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
