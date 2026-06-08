from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class RunCreate(BaseModel):
    scenario_id: UUID


class RunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    scenario_id: UUID
    agent_id: UUID
    suite_id: UUID | None
    status: str
    verdict: str | None
    started_at: datetime | None
    ended_at: datetime | None
    plivo_call_uuid: str | None
    recording_url: str | None
    transcript_text: str | None
    judge_result: dict[str, Any] | None
    usage: dict[str, Any] | None
    error: str | None
    created_at: datetime


class RunTrendBucketRead(BaseModel):
    date: str
    run_count: int
    pass_count: int
    fail_count: int
    pending_count: int
    pass_rate: int | None
    avg_duration_seconds: int | None


class RunFailureHotspotRead(BaseModel):
    scenario_id: UUID
    latest_run_id: UUID
    fail_count: int
    latest_reason: str


class RunAnalyticsRead(BaseModel):
    generated_at: datetime
    days: int
    run_count: int
    pass_count: int
    fail_count: int
    pending_count: int
    pass_rate: int | None
    avg_duration_seconds: int | None
    p95_duration_seconds: int | None
    trend: list[RunTrendBucketRead]
    top_failures: list[RunFailureHotspotRead]
