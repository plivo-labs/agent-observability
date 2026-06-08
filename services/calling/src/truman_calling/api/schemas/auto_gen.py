from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from truman_calling.api.schemas.rubrics import Criterion


class AutoGenRequest(BaseModel):
    agent_system_prompt: str = Field(
        ..., description="The target voice agent's system prompt — what we're QA-ing."
    )
    agent_id: UUID | None = None
    count: int = Field(default=10, ge=1, le=20)
    language: str = "en"
    scenario_type: Literal["mixed", "workflow", "edge", "redteam", "knowledge"] = "mixed"
    extra_instructions: str = Field(default="", max_length=2000)
    scenario_brief: str = Field(
        default="",
        max_length=2000,
        description="Natural-language Quick Mode scenario intent to turn into a full evaluator.",
    )


class AutoGenCandidate(BaseModel):
    name: str
    scenario_class: str
    persona_prompt: str
    opener_instructions: str
    expected_outcomes: str
    rubric_criteria: list[Criterion]


class AutoGenResponse(BaseModel):
    candidates: list[AutoGenCandidate]
