from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ScenarioCreate(BaseModel):
    name: str
    agent_id: UUID
    persona_id: UUID
    rubric_id: UUID
    profile_id: UUID | None = None
    expected_outcomes: str | None = None
    opener_instructions: str
    language: str = "en"
    tags: list[str] = Field(default_factory=list)
    max_call_duration_seconds: int = Field(default=600, ge=30, le=3600)
    allow_dtmf: bool = False
    allow_sms: bool = False
    allow_end_call: bool = True


class ScenarioUpdate(BaseModel):
    name: str | None = None
    agent_id: UUID | None = None
    persona_id: UUID | None = None
    rubric_id: UUID | None = None
    profile_id: UUID | None = None
    expected_outcomes: str | None = None
    opener_instructions: str | None = None
    language: str | None = None
    tags: list[str] | None = None
    max_call_duration_seconds: int | None = Field(default=None, ge=30, le=3600)
    allow_dtmf: bool | None = None
    allow_sms: bool | None = None
    allow_end_call: bool | None = None


class ScenarioRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    agent_id: UUID
    persona_id: UUID
    rubric_id: UUID
    profile_id: UUID | None
    expected_outcomes: str | None
    opener_instructions: str
    language: str
    tags: list[str]
    max_call_duration_seconds: int
    allow_dtmf: bool
    allow_sms: bool
    allow_end_call: bool


class ScenarioRevisionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    scenario_id: UUID
    version: int
    change_summary: str
    changed_fields: list[str]
    snapshot: dict[str, Any]
    created_at: datetime
