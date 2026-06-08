from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from truman_calling.api.schemas.runs import RunRead


class SuiteCreate(BaseModel):
    agent_id: UUID
    scenario_ids: list[UUID] = Field(..., min_length=1, max_length=20)
    name: str | None = None


class SuiteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str | None
    status: str
    created_at: datetime


class SuiteReadDetail(SuiteRead):
    runs: list[RunRead] = Field(default_factory=list)
