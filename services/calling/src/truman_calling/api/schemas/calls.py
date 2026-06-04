from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import AliasChoices, BaseModel, Field


class TranscriptSegment(BaseModel):
    role: str
    content: str
    start_time: float | None = None
    end_time: float | None = None


class ObservedCallIngest(BaseModel):
    agent_id: UUID = Field(validation_alias=AliasChoices("agent_id", "agent"))
    provider: str = Field(default="custom", min_length=1, max_length=64)
    external_call_id: str = Field(
        validation_alias=AliasChoices("external_call_id", "call_id"),
        min_length=1,
        max_length=256,
    )
    voice_recording_url: str | None = None
    transcript_type: str = Field(default="custom", min_length=1, max_length=32)
    transcript_json: list[TranscriptSegment] | None = None
    transcript_text: str | None = None
    call_ended_reason: str | None = Field(default=None, max_length=256)
    status: str = Field(default="ingested", min_length=1, max_length=32)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    duration_seconds: int | None = Field(default=None, ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ObservedCallRead(BaseModel):
    id: UUID
    agent_id: UUID
    provider: str
    external_call_id: str
    voice_recording_url: str | None
    transcript_type: str
    transcript_json: list[dict[str, Any]] | None
    transcript_text: str | None
    call_ended_reason: str | None
    status: str
    started_at: datetime | None
    ended_at: datetime | None
    duration_seconds: int | None
    metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime
