"""Wraps a DB-stored Rubric row as a duck-typed module with the same shape
as the bundled spike rubric (`mamaearth_v1`)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

JUDGE_USER_TEMPLATE = """Score the call below against the criteria. Respond with STRICT JSON only — no prose, no markdown fences.

Schema:
{{
  "criteria": [
    {{"name": "<key>", "pass": true|false, "justification": "<one line, quote from transcript>"}}
  ],
  "overall": "pass" | "fail",
  "notes": "<one or two sentences of overall assessment>"
}}

Criteria (use these exact keys, in this order):
{criteria_block}

Transcript:
<<<
{transcript}
>>>
"""

JUDGE_SYSTEM_PROMPT = (
    "You are a strict evaluator scoring a recorded customer-support call. "
    "Only mark a criterion as pass if there is clear, quoted evidence in the transcript. "
    "If a criterion is not applicable, mark it pass and explain why."
)


def build_rubric_module(rubric_row: Any) -> Any:
    """Returns a module-like object with NAME, JUDGE_SYSTEM_PROMPT, render_judge_user_prompt."""
    criteria_block = "\n".join(
        f"- {c.get('key', f'c{i}')}: {c.get('question', '')}"
        for i, c in enumerate(rubric_row.criteria)
    )

    def render(transcript: str) -> str:
        return JUDGE_USER_TEMPLATE.format(
            criteria_block=criteria_block, transcript=transcript
        )

    return SimpleNamespace(
        NAME=rubric_row.name,
        JUDGE_SYSTEM_PROMPT=JUDGE_SYSTEM_PROMPT,
        render_judge_user_prompt=render,
    )
