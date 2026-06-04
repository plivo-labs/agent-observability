from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class EvaluationScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    agent_id: UUID
    scenario_ids: list[UUID] = Field(min_length=1, max_length=50)
    cron_expression: str = Field(min_length=9, max_length=128)
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    personality_override_ids: list[UUID] = Field(default_factory=list, max_length=20)
    execution_mode: Literal["voice", "chat"] = "voice"
    run_limit: int | None = Field(default=None, ge=1, le=1000)
    is_enabled: bool = True


class EvaluationScheduleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    agent_id: UUID | None = None
    scenario_ids: list[UUID] | None = Field(default=None, min_length=1, max_length=50)
    cron_expression: str | None = Field(default=None, min_length=9, max_length=128)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    personality_override_ids: list[UUID] | None = Field(default=None, max_length=20)
    execution_mode: Literal["voice", "chat"] | None = None
    run_limit: int | None = Field(default=None, ge=1, le=1000)
    is_enabled: bool | None = None


class EvaluationScheduleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    agent_id: UUID
    scenario_ids: list[UUID]
    cron_expression: str
    timezone: str
    personality_override_ids: list[UUID]
    execution_mode: str
    run_limit: int | None
    run_count: int
    is_enabled: bool
    last_run_at: datetime | None
    next_run_at: datetime | None
    created_at: datetime
    updated_at: datetime
