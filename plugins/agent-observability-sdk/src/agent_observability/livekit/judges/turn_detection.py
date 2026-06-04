"""Turn-detection judge for end-of-utterance fragments."""

from __future__ import annotations

from typing import Iterable, Mapping, Any

from livekit.agents.llm import LLM

from agent_observability.livekit.judges._base import _LLMJudge
from agent_observability.livekit.judges._instructions import TURN_DETECTION


def _format_fragments(fragments: Iterable[str | Mapping[str, Any]]) -> str:
    out: list[str] = []
    for i, fragment in enumerate(fragments):
        if isinstance(fragment, Mapping):
            text = fragment.get("transcribed_text") or fragment.get("text") or ""
            flags = []
            for key in ("is_eou", "was_delayed_timeout", "eou_probability"):
                if key in fragment:
                    flags.append(f"{key}={fragment[key]}")
            suffix = f" ({', '.join(flags)})" if flags else ""
            out.append(f"fragment_{i}: {text}{suffix}")
        else:
            out.append(f"fragment_{i}: {fragment}")
    return "\n".join(out) or "(none)"


def turn_detection_judge(
    *,
    fragments: Iterable[str | Mapping[str, Any]],
    llm: LLM | None = None,
) -> _LLMJudge:
    """Evaluate premature end-of-utterance and missed end-of-utterance errors."""
    return _LLMJudge(
        llm=llm,
        name="turn_detection",
        instructions=TURN_DETECTION.format(fragments=_format_fragments(fragments)),
    )
