"""Core judge runner: builds prompt, calls LLM once, parses result, records judgments."""

from __future__ import annotations

import json
import re
from typing import Any

from ..collector import _record_judgment
from .prompt import build_prompt
from .rubrics import Rubric
from .types import JudgeInput, LLMClient

__all__ = ["JudgeInput", "LLMClient", "evaluate"]


def evaluate(
    rubrics: list[Rubric],
    input: JudgeInput,
    llm: LLMClient,
    threshold: float = 0.7,
) -> dict[str, dict[str, Any]]:
    """Call the LLM once for all rubrics, parse JSON result, record judgments.

    Returns a map of rubric_name -> {"score": float, "reason": str, "verdict": str}.
    On total parse failure returns {} and records a single judge_failed judgment.
    """
    prompt = build_prompt(rubrics, input)
    raw = llm.evaluate(prompt)

    parsed = _parse_json(raw)
    if parsed is None:
        _record_judgment(
            intent="judge_failed",
            verdict="error",
            reasoning=raw,
        )
        return {}

    results: dict[str, dict[str, Any]] = {}
    for rubric in rubrics:
        entry = parsed.get(rubric.name)
        if not isinstance(entry, dict):
            continue
        score = float(entry.get("score", 0.0))
        reason = str(entry.get("reason", ""))
        verdict = "pass" if score >= threshold else "fail"
        _record_judgment(
            intent=rubric.name,
            verdict=verdict,
            reasoning=reason,
            name=rubric.name,
            score=score,
            threshold=threshold,
        )
        results[rubric.name] = {"score": score, "reason": reason, "verdict": verdict}

    return results


def _parse_json(raw: str) -> dict | None:
    """Try strict JSON parse, then extract first {...} block. Returns None on failure."""
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group())
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    return None
