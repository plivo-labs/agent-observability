"""Build the combined LLM judge prompt for one or more rubrics."""

from __future__ import annotations

import json

from .rubrics import Rubric
from .types import JudgeInput


def build_prompt(rubrics: list[Rubric], input: JudgeInput) -> str:
    """Return a single prompt string instructing the model to evaluate all rubrics.

    The model must reply with JSON:
      {"<rubric_name>": {"score": float, "reason": str}, ...}
    """
    sections: list[str] = []

    sections.append(
        "You are an objective evaluator. Assess the agent response below against each "
        "rubric criterion and return ONLY a JSON object. No prose outside the JSON.\n"
        "Response format:\n"
        '{"<rubric_name>": {"score": <float 0.0-1.0>, "reason": "<brief explanation>"}, ...}'
    )

    # --- Input slots (omit empty) ---
    if input.system_prompt:
        sections.append(f"<system_prompt>\n{input.system_prompt}\n</system_prompt>")

    if input.task_instructions:
        sections.append(
            f"<task_instructions>\n{input.task_instructions}\n</task_instructions>"
        )

    if input.context:
        ctx = (
            "\n".join(input.context)
            if isinstance(input.context, list)
            else input.context
        )
        sections.append(f"<context>\n{ctx}\n</context>")

    if input.conversation_history:
        history_text = json.dumps(input.conversation_history, indent=2)
        sections.append(
            f"<conversation_history>\n{history_text}\n</conversation_history>"
        )

    sections.append(f"<agent_response>\n{input.response}\n</agent_response>")

    # --- Rubric definitions ---
    for rubric in rubrics:
        steps_text = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(rubric.steps))
        sections.append(
            f"<rubric name=\"{rubric.name}\">\n"
            f"Criteria: {rubric.criteria}\n"
            f"Evaluation steps:\n{steps_text}\n"
            f"</rubric>"
        )

    sections.append(
        "Now produce the JSON evaluation object for the rubric(s) above. "
        "Use the exact rubric names as keys."
    )

    return "\n\n".join(sections)
